# 集成测试适配架构设计

> 版本: 1.0  
> 目标: 使用现有 TypeScript MumbleClient，对 Rust 实现运行全部集成测试

---

## 1. 目标与约束

### 目标
- Rust Hub + Rust Edge 能通过与 TypeScript 版本相同的集成测试
- 尽量少修改测试文件本身，将适配逻辑集中在 `setup.ts`
- 测试客户端（`MumbleClient`）保持 TypeScript 实现，不做修改

### 约束
- 集成测试使用 Vitest（单进程模式 `singleFork: true`）
- 当前 `setup.ts` 直接实例化 TS 类；Rust 模式需要子进程管理
- 部分测试引用 `testEnv.hubServer` / `testEnv.edgeServer` 实例（需兼容处理）
- Hub 重启测试（`hub-restart.test.ts`）需要能控制 Hub 进程生命周期

---

## 2. 整体方案

### 环境变量控制

```bash
# TypeScript 模式（默认）
pnpm test:integration

# Rust 模式
MUNODE_USE_RUST=1 pnpm test:integration
```

### 切换逻辑（setup.ts）

```typescript
const USE_RUST = process.env.MUNODE_USE_RUST === '1';

if (USE_RUST) {
  // 写入临时 JSON 配置文件
  // spawn Rust 二进制进程
  // 等待端口监听
} else {
  // 原有 TS 服务器实例化逻辑
}
```

---

## 3. TestEnvironment 接口变更

添加可选的进程句柄字段，同时保持对 `hubServer`/`edgeServer` 的向后兼容：

```typescript
export interface TestEnvironment {
  // 原有字段（TS 模式下有值，Rust 模式下为 undefined）
  hubServer?: HubServer;
  edgeServer?: EdgeServer;
  edgeServer2?: EdgeServer;
  edgeServer3?: EdgeServer;
  edgeServer4?: EdgeServer;
  
  // Rust 模式新增（Rust 模式下有值，TS 模式下为 undefined）
  hubProcess?: RustServerProcess;
  edgeProcess?: RustServerProcess;
  edgeProcess2?: RustServerProcess;
  edgeProcess3?: RustServerProcess;
  edgeProcess4?: RustServerProcess;
  
  // 其余字段不变
  authServer?: TestAuthServer;
  authPort: number;
  hubPort: number;
  controlPort: number;
  webApiPort: number;
  // ...
}
```

### RustServerProcess 接口

```typescript
interface RustServerProcess {
  pid: number;
  configPath: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}
```

---

## 4. Rust 进程配置生成

### Hub 配置（JSON）

测试启动时，为每次测试动态生成唯一的 JSON 配置文件（写入 `/tmp/`），避免多测试套件冲突：

```json
{
  "network": {
    "host": "127.0.0.1",
    "control_port": 11080,
    "auth_service_port": null
  },
  "database": {
    "path": "/path/to/data/hub-test-8080.db"
  },
  "auth": {
    "allow_guest": true,
    "http_url": "http://127.0.0.1:8080/auth",
    "require_auth_service": false
  },
  "registry": {
    "hmac_secret": "test-hmac-secret-key-for-integration-tests"
  },
  "log_level": "error"
}
```

### Edge 配置（JSON）

```json
{
  "server_id": 1,
  "name": "MuNode Edge Server 1 (Rust Test)",
  "network": {
    "host": "0.0.0.0",
    "port": 10080,
    "edge_port": 10081,
    "external_host": "127.0.0.1"
  },
  "tls": {
    "cert": "./tests/integration/certs/server.pem",
    "key": "./tests/integration/certs/server.key",
    "ca": "./tests/integration/certs/ca.pem"
  },
  "hub_server": {
    "host": "127.0.0.1",
    "control_port": 11080,
    "hmac_secret": "test-hmac-secret-key-for-integration-tests",
    "reconnect_interval": 5000,
    "heartbeat_interval": 30000
  },
  "log_level": "error"
}
```

---

## 5. 认证方案

### 当前 TS 方案

```
TestAuthServer (HTTP) ← HubServer.auth.api_url → HTTP POST /auth
```

### Rust 方案（新增 HTTP auth URL）

```
TestAuthServer (HTTP) ← HubServer.auth.http_url → HTTP POST /auth
```

Rust Hub 收到 `edge.authenticateUser` RPC 时：
1. 若 `auth.http_url` 已设置 → 向该 URL 发送 HTTP POST（reqwest）
2. 请求体：`{ username, password, tokens, server_id }`
3. 响应解析：`{ success, user_id, username, groups }`
4. 若 HTTP 调用失败且 `require_auth_service=false` → 回退到本地数据库认证

---

## 6. 数据库初始化

Rust Hub 使用与 TS Hub 相同的 SQLite schema（表名、字段名相同）。
集成测试通过 `scripts/init-test-db.ts` 初始化数据库，Rust Hub 可直接使用同一数据库文件。

适配步骤：
1. 运行 `tsx scripts/init-test-db.ts <db_path>` 初始化数据库
2. Rust Hub 配置 `database.path` 指向同一文件

> 注意：Rust Hub 和 TS Hub 的数据库 schema 必须保持一致（迁移版本同步）。

---

## 7. Rust 二进制路径

```typescript
const RUST_HUB_BIN = join(PROJECT_ROOT, 'rust/target/release/munode-hub');
const RUST_EDGE_BIN = join(PROJECT_ROOT, 'rust/target/release/munode-edge');
// Debug 构建（测试环境）
const RUST_HUB_BIN_DEBUG = join(PROJECT_ROOT, 'rust/target/debug/munode-hub');
const RUST_EDGE_BIN_DEBUG = join(PROJECT_ROOT, 'rust/target/debug/munode-edge');
```

检测逻辑：优先使用 release，回退到 debug，若均不存在则报错（需先 `cargo build`）。

---

## 8. TS 特有测试处理

### multi-tenant-sni.test.ts

此测试直接导入 TS 类（`VirtualHostManager`, `SecureContextManager`）进行单元测试。

**策略**：Rust 模式下，这些测试仍然运行（因为它们测试的是 TS 层的管理类，与 Rust 无关）。
Rust 实现的 SNI 功能通过网络行为测试验证（后续 T24）。

### worker-pool.test.ts

测试 TS 的 `CryptoWorkerPool`（通过 `edgeServer.getCryptoWorkerPool()` 访问）。

**策略**：Rust 模式下，`testEnv.edgeServer` 为 undefined，相关测试会跳过（因为 `getCryptoWorkerPool()` 返回 undefined）。
需要在测试中添加 Rust 模式下的替代验证（并发加密操作验证）。

### hub-restart.test.ts / voice.test.ts（使用 hubServer.stop()/start()）

这些测试直接调用 `testEnv.hubServer.stop()` / `testEnv.hubServer.start()`。

**策略**：`TestEnvironment.hubServer` 改为包装类，当使用 Rust 进程时，`stop()`/`start()` 转发到 `hubProcess.stop()`/`hubProcess.restart()`。

---

## 9. Web API 端口

部分测试配置中使用 `webApiPort`（如 `edge-external-port.test.ts`）。

**短期**：Rust 模式下，`webApiPort` 注册为 0（未使用），相关测试如需 Web API 则需适配。
**长期**：可为 Rust Hub 添加简单 HTTP 管理 API（参考 T26）。

---

## 10. 实现步骤

1. **Rust Hub HTTP 认证** - 修改 `munode-common/src/config.rs`（添加 `http_url`）和 `munode-hub/src/rpc_handler.rs`（添加 HTTP 调用逻辑）

2. **setup.ts 适配** - 添加 Rust 进程管理，生成临时配置文件

3. **编译验证** - `cargo build && MUNODE_USE_RUST=1 pnpm test:integration`

4. **逐步修复** - 根据测试失败信息补充 Rust 实现

---

## 参考

- TS 测试设置：`tests/integration/setup.ts`  
- Rust Hub 配置：`rust/munode-common/src/config.rs`  
- Rust Hub RPC：`rust/munode-hub/src/rpc_handler.rs`  
- 测试用户列表：`tests/integration/test-users.ts`  
