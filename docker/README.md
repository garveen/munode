# MuNode Docker 部署指南

## 目录结构

```
node/
├── packages/
│   ├── hub-server/
│   │   └── Dockerfile          # Hub 服务器镜像
│   ├── edge-server/
│   │   └── Dockerfile          # Edge 服务器镜像
│   └── client/
│       └── Dockerfile          # 无头客户端镜像
├── docker-compose.yml          # 生产环境编排
├── docker-compose.dev.yml      # 开发环境编排
└── .dockerignore               # Docker 构建忽略文件
```

## 快速启动

### 生产环境

#### 1. 准备配置文件

确保以下配置文件存在：

```bash
# Hub 配置
cp config/hub.example.json config/hub.json

# Edge 配置
cp config/edge.example.json config/edge.json

# 第二个 Edge 配置（可选）
cp config/edge.example.json config/edge-2.json
```

#### 2. 启动基础服务（Hub + Edge-1）

```bash
docker-compose up -d
```

#### 3. 启动完整服务（包括 Edge-2 和 Client）

```bash
docker-compose --profile full up -d
```

#### 4. 查看日志

```bash
# 所有服务
docker-compose logs -f

# 特定服务
docker-compose logs -f hub
docker-compose logs -f edge-1
```

#### 5. 停止服务

```bash
docker-compose down
```

### 开发环境

开发环境使用热重载，代码修改会自动重启服务。

```bash
# 启动开发环境
docker-compose -f docker-compose.dev.yml up

# 后台运行
docker-compose -f docker-compose.dev.yml up -d

# 停止开发环境
docker-compose -f docker-compose.dev.yml down
```

## 服务说明

### Hub Server

- **端口**: 8443 (gRPC)
- **功能**: 中心管理节点，负责用户认证、权限管理、数据持久化
- **配置**: `/app/config/hub.json`
- **数据**: `/app/data/hub.sqlite`

### Edge Server

- **端口**: 64738 (TCP/UDP)
- **功能**: 边缘节点，处理客户端连接、实时语音传输
- **配置**: `/app/config/edge.json`
- **依赖**: Hub Server

#### 多 Edge 部署

Edge-2 使用不同的主机端口（64739）映射到容器的 64738 端口：

```bash
# 仅启动 Edge-2
docker-compose --profile full up -d edge-2
```

### Headless Client

- **端口**: 3000 (HTTP API), 3001 (WebSocket)
- **功能**: 无头客户端，用于测试、自动化、机器人
- **配置**: `/app/config/client.json`
- **依赖**: Edge Server

## 构建镜像

### 单独构建

```bash
# Hub
docker build -f packages/hub-server/Dockerfile -t munode-hub .

# Edge
docker build -f packages/edge-server/Dockerfile -t munode-edge .

# Client
docker build -f packages/client/Dockerfile -t munode-client .
```

### 通过 Compose 构建

```bash
# 构建所有服务
docker-compose build

# 构建特定服务
docker-compose build hub
docker-compose build edge-1
```

## 环境变量

### Hub Server

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NODE_ENV` | 运行环境 | `production` |
| `LOG_LEVEL` | 日志级别 | `info` |

### Edge Server

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NODE_ENV` | 运行环境 | `production` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `HUB_HOST` | Hub 服务器地址 | `hub` |
| `HUB_PORT` | Hub 服务器端口 | `8443` |
| `EDGE_NAME` | Edge 节点名称 | - |

### Client

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NODE_ENV` | 运行环境 | `production` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `EDGE_HOST` | Edge 服务器地址 | `edge-1` |
| `EDGE_PORT` | Edge 服务器端口 | `64738` |

## 数据持久化

### Volumes 配置

```yaml
volumes:
  - ./config:/app/config:ro          # 配置文件（只读）
  - ./data:/app/data                 # 数据文件
  - ./session:/app/session           # 会话数据（Hub）
  - ./logs:/app/logs                 # 日志文件
```

### 备份数据

```bash
# 备份 Hub 数据库
docker-compose exec hub cp /app/data/hub.sqlite /app/data/backups/hub-$(date +%Y%m%d).sqlite

# 或直接复制主机文件
cp data/hub.sqlite data/backups/hub-$(date +%Y%m%d).sqlite
```

## 网络配置

### 内部网络

所有服务使用 `munode-network` 桥接网络（子网：172.20.0.0/16）。

服务间通过容器名通信：
- Hub: `hub:8443`
- Edge-1: `edge-1:64738`
- Edge-2: `edge-2:64738`

### 外部访问

- Hub: 不对外暴露（仅内部 Edge 访问）
- Edge-1: `localhost:64738`
- Edge-2: `localhost:64739`
- Client: `localhost:3000` (HTTP), `localhost:3001` (WebSocket)

## 健康检查

所有服务都配置了健康检查：

```bash
# 查看健康状态
docker-compose ps

# 手动检查
docker-compose exec hub node -e "..."
```

## 调试

### 开发环境调试

开发环境暴露 Node.js 调试端口：

- Hub: `9229`
- Edge: `9230`
- Client: `9231`

在 VSCode 中配置 `.vscode/launch.json`：

```json
{
  "type": "node",
  "request": "attach",
  "name": "Attach to Hub (Docker)",
  "address": "localhost",
  "port": 9229,
  "localRoot": "${workspaceFolder}",
  "remoteRoot": "/app"
}
```

### 生产环境日志

```bash
# 实时日志
docker-compose logs -f

# 查看特定服务最近 100 行日志
docker-compose logs --tail=100 hub

# 导出日志
docker-compose logs > logs/docker-compose.log
```

## 性能优化

### 多阶段构建

Dockerfile 使用多阶段构建：
1. **builder**: 编译 TypeScript
2. **runner**: 仅包含生产依赖和编译后的 JS

### 依赖缓存

通过分层复制优化构建缓存：
1. 先复制 `package.json` 和 `pnpm-lock.yaml`
2. 安装依赖
3. 再复制源代码
4. 最后构建

### 镜像大小

- 基础镜像: `node:22-alpine` (轻量级)
- 生产镜像: 仅包含运行时依赖
- Client 镜像: 包含 ffmpeg 和 opus

## 常见问题

### 1. Edge 无法连接 Hub

检查 Hub 健康状态和网络配置：

```bash
docker-compose ps hub
docker-compose logs hub
docker-compose exec edge-1 ping hub
```

### 2. 端口冲突

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "64740:64738/tcp"  # 使用不同主机端口
```

### 3. 数据库权限问题

确保数据目录有正确权限：

```bash
chmod -R 777 data
chmod -R 777 logs
```

### 4. 构建失败

清理缓存并重新构建：

```bash
docker-compose build --no-cache
```

## 生产部署建议

1. **反向代理**: 使用 Nginx 或 Traefik 作为反向代理
2. **TLS 证书**: 配置 Let's Encrypt 自动更新证书
3. **资源限制**: 在 `docker-compose.yml` 中添加资源限制
4. **监控**: 集成 Prometheus + Grafana 监控
5. **日志**: 使用 ELK 或 Loki 聚合日志
6. **备份**: 设置定时备份数据库和配置
7. **高可用**: 部署多个 Edge 节点实现负载均衡

## 相关文档

- [部署指南](../DEPLOYMENT.md)
- [配置说明](../docs/HUB_CONFIG_GUIDE.md)
- [架构文档](../docs/)
