# 多虚拟服务器方案设计

> 本文档列出 MuNode 支持多虚拟服务器（Multiple Virtual Servers）的几种可选方案，
> 供选型参考。**暂不考虑 ICE（ZeroC Ice）协议**。

---

## 背景

Murmur 支持单进程内运行多个独立的虚拟服务器（Virtual Servers），每个虚拟服务器有独立的：
- 监听端口（TCP + UDP）
- TLS 证书
- 数据库（用户、频道、ACL、封禁列表）
- 欢迎语/配置
- 在线用户和频道树

MuNode 目前采用"单 Hub + 多 Edge"的分布式架构，通过部署多套 Hub+Edge 实例来实现逻辑上的多服务器。
本文档探讨在现有架构基础上或调整架构以支持真正意义上的多虚拟服务器的几种方式。

---

## 方案一：Hub 多租户（推荐方向）

### 核心思路

在现有 Hub 中引入 **VirtualServer（虚拟服务器）** 概念，所有数据库实体（用户、频道、ACL、封禁）
都携带一个 `server_id` 字段，从而在单一 Hub 进程内隔离多个服务器的数据。

```
Hub 进程
├── VirtualServer #1 (server_id=1)
│   ├── 数据：channels, users, acls (server_id=1)
│   └── 会话：sessions, channel_tree
├── VirtualServer #2 (server_id=2)
│   ├── 数据：channels, users, acls (server_id=2)
│   └── 会话：sessions, channel_tree
└── ...
```

每个 Edge 在注册时声明它属于哪个 `server_id`，Hub 的 RPC 调用均携带 `server_id`。

### 数据库变更

所有核心表（`channels`、`acls`、`channel_groups`、`users`、`bans`）添加 `server_id INTEGER NOT NULL DEFAULT 1` 列，
并调整查询为按 `server_id` 过滤。新增 `virtual_servers` 元数据表：

```sql
CREATE TABLE virtual_servers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    welcome_text TEXT,
    max_users   INTEGER NOT NULL DEFAULT 100,
    -- TLS 证书路径或内联 PEM
    cert_path   TEXT,
    key_path    TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### Web API 变更

Hub 的 REST API 扩展 `/virtual-servers` 端点（CRUD），允许动态创建/删除虚拟服务器。
Edge 通过新增的 `ServerCreate` / `ServerDelete` Hub 事件感知变更。

### 优点
- 单一 Hub 进程、单一数据库文件，管理简单
- 共享内存中的会话状态，跨服务器操作（如全局封禁）实现成本低
- 与现有 Hub-Edge WebSocket RPC 架构高度兼容，只需在 RPC 消息头中加 `server_id` 字段

### 缺点
- 需要对数据库 schema 和所有查询函数做较大改动（加 `server_id` 过滤）
- Hub 进程崩溃会影响所有虚拟服务器
- 各虚拟服务器无法独立重启或独立升级

### 实现复杂度：⭐⭐⭐（中等）

---

## 方案二：每个虚拟服务器独立 Hub 进程 + 统一 Orchestrator

### 核心思路

保持 Hub 代码不变（单服务器模式），在外层增加一个轻量级 **Orchestrator** 进程负责：
1. 管理多个 Hub 子进程（`tokio::process::Command` 或 `std::process::Command` + supervisor）
2. 为每个 Hub 分配独立的端口段和数据库文件
3. 提供统一的 Web API 代理层（类 `nginx upstream` 路由请求到正确的 Hub）

```
Orchestrator（9000 端口）
├── Hub #1 进程（内部端口 9101，DB: /data/server1.db）
│   └── Edge(s) → Hub #1
├── Hub #2 进程（内部端口 9102，DB: /data/server2.db）
│   └── Edge(s) → Hub #2
└── ...
```

### Orchestrator 功能

- `POST /servers` → 启动新 Hub 进程，返回 server_id
- `DELETE /servers/{id}` → 停止并清理 Hub 进程
- `GET /servers` → 列出所有虚拟服务器状态
- 健康检查：自动重启崩溃的 Hub 子进程

### 优点
- Hub 代码几乎无需修改，风险最低
- 进程级隔离，一台虚拟服务器崩溃不影响其他
- 每台虚拟服务器可独立配置资源限制（cgroup/ulimit）

### 缺点
- 需要新建一个 `munode-orchestrator` crate
- 端口管理较复杂（需要端口分配器防止冲突）
- 进程间无共享内存，全局操作（如跨服务器封禁）需通过 API 实现
- 进程启动有延迟（数百毫秒），不适合频繁动态创建/销毁

### 实现复杂度：⭐⭐（较低，核心代码改动最小）

---

## 方案三：Edge 多绑定（轻量虚拟服务器）

### 核心思路

对 Edge 服务器进行改造，使其能在同一进程内绑定多个 `(host, port)` 组合，
每个绑定对应一个独立的 `server_id`。Hub 仍然是单实例，但 Hub 的数据库按 `server_id` 分区。

```
Edge 进程
├── TcpListener 0.0.0.0:64738 (server_id=1)
├── TcpListener 0.0.0.0:64739 (server_id=2)
└── UdpSocket   0.0.0.0:64738, 0.0.0.0:64739 (各自独立)

Hub 进程（单实例，多租户数据库）
```

新连接到 `64738` 的客户端自动归属 `server_id=1`；所有 Hub RPC 都携带 `server_id`。

### Edge 配置格式变更

```toml
[[server]]
server_id = 1
name = "主服务器"
port = 64738
cert = "/certs/server1.crt"
key  = "/certs/server1.key"

[[server]]
server_id = 2
name = "测试服务器"
port = 64739
cert = "/certs/server2.crt"
key  = "/certs/server2.key"
```

### 优点
- Edge 代码改动量中等，Hub 需配合做多租户数据分区
- 每个端口的 TLS 证书独立（不同域名可对应不同证书）
- 不需要额外的 Orchestrator 进程

### 缺点
- Hub 仍需要实现多租户（等同于方案一的数据库部分）
- Edge 进程内的状态需要严格按 `server_id` 隔离，改动面较大
- Edge 进程崩溃会影响所有虚拟服务器

### 实现复杂度：⭐⭐⭐（中等，与方案一组合使用）

---

## 方案四：容器编排（零代码改动）

### 核心思路

不修改任何代码，直接通过 **Docker Compose / Kubernetes** 部署多套 Hub+Edge 实例，
每套实例使用不同的端口和数据目录。

```yaml
# docker-compose.yml 示例
services:
  hub-1:
    image: munode-hub
    volumes: ["./data/server1:/data"]
    environment: ["HUB_PORT=9001"]

  edge-1:
    image: munode-edge
    ports: ["64738:64738/tcp", "64738:64738/udp"]
    environment: ["HUB_URL=ws://hub-1:9001", "SERVER_PORT=64738"]

  hub-2:
    image: munode-hub
    volumes: ["./data/server2:/data"]
    environment: ["HUB_PORT=9002"]

  edge-2:
    image: munode-edge
    ports: ["64739:64739/tcp", "64739:64739/udp"]
    environment: ["HUB_URL=ws://hub-2:9002", "SERVER_PORT=64739"]
```

### 优点
- **零代码改动**，即可在今天使用
- 完全的进程/存储隔离
- 可按需扩缩容（K8s HPA）
- 运维工具链成熟（日志、监控、滚动更新均有现成方案）

### 缺点
- 管理多台虚拟服务器需要操作多个 Compose/K8s 配置，没有统一 API
- 无全局管理面板（除非自建）
- 资源利用率较低（每个虚拟服务器都有独立的 tokio runtime）

### 实现复杂度：⭐（最低，无需代码修改）

---

## 方案对比总结

| 维度 | 方案一（Hub 多租户） | 方案二（多进程 + Orchestrator） | 方案三（Edge 多绑定） | 方案四（容器编排） |
|---|---|---|---|---|
| 代码改动量 | 大（Hub + DB schema） | 小（新增 Orchestrator） | 中（Edge + Hub） | 无 |
| 进程隔离 | 无（共享进程） | 完整 | 无 | 完整 |
| 动态创建/删除 | 支持（运行时） | 支持（进程级） | 支持（重启） | 不支持（需重启 Compose） |
| 独立 TLS 证书 | 需要 SNI 路由 | 天然支持 | 天然支持 | 天然支持 |
| 独立数据库 | 同一文件多分区 | 独立文件 | 同一文件多分区 | 独立文件 |
| 全局管理 API | 统一 | 需 Orchestrator 代理 | 统一 | 无（除非外部自建） |
| 实现复杂度 | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐ |
| 建议场景 | 高密度小型虚拟服务器 | 需强隔离的商业托管 | 与方案一配合 | 快速部署 / 测试环境 |

---

## 建议

- **短期（今天即可）**：使用 **方案四**（Docker Compose）快速实现多服务器部署，满足基本需求。
- **中期**：在方案四的基础上，实现 **方案二**（Orchestrator）提供统一的管理 API。
- **长期**：如需高密度虚拟服务器（如托管数十台），考虑 **方案一**（Hub 多租户），
  在数据库 schema 中引入 `server_id` 分区，并扩展 RPC 协议携带 `server_id`。

方案三（Edge 多绑定）可以作为方案一的前置步骤或补充，无需单独立项。
