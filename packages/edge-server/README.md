# Mumble Edge Server

Mumble 分布式服务器的边缘节点实现，负责处理客户端连接、语音路由、频道管理等核心功能。

## 功能特性

- **高性能连接处理**: 支持 TCP/TLS/UDP 多协议并发连接
- **分布式架构**: 支持集群模式，与 Hub Server 协同工作
- **语音路由**: 高效的语音包路由和转发，支持语音目标
- **频道管理**: 完整的频道树结构管理，支持权限控制
- **用户认证**: 支持外部 API 认证和本地认证回退
- **安全特性**:
  - GeoIP 地理位置查询和 ACL 规则
  - 完善的封禁管理系统
  - 证书哈希混淆保护隐私
- **性能优化**:
  - UDP 连接池管理
  - LRU 缓存系统
  - 网络质量监控
- **扩展功能**:
  - 右键菜单系统 (Context Actions)
  - 用户缓存系统
  - P2P 对等连接

## 安装

```bash
# 安装依赖
pnpm install

# 构建项目
pnpm build
```

## 配置

创建配置文件 `config/edge-server.json`:

```json
{
  "serverId": 1,
  "name": "Edge Server 1",
  "mode": "cluster",
  "network": {
    "host": "0.0.0.0",
    "port": 64738,
    "externalHost": "your-server.com"
  },
  "tls": {
    "cert": "/path/to/server.crt",
    "key": "/path/to/server.key",
    "ca": "/path/to/ca.crt"
  },
  "hubServer": {
    "host": "hub-server.com",
    "port": 64739,
    "tls": {
      "rejectUnauthorized": true
    },
    "connectionType": "grpc",
    "reconnectInterval": 5000,
    "heartbeatInterval": 30000
  },
  "auth": {
    "apiUrl": "https://auth.example.com/api",
    "apiKey": "your-api-key",
    "timeout": 5000,
    "cacheTTL": 3600000,
    "pullInterval": 300000
  },
  "features": {
    "geoip": true,
    "banSystem": true,
    "contextActions": true,
    "userCache": true,
    "packetPool": true,
    "udpMonitor": true,
    "certObfuscation": true
  }
}
```

## 运行

### 开发模式

```bash
pnpm dev
```

### 生产模式

```bash
pnpm start
```

### 命令行选项

```bash
# 启动服务器
pnpm start -- --config ./config/edge-server.json

# 指定端口和主机
pnpm start -- --port 64738 --host 0.0.0.0

# 集群模式配置 Hub 服务器
pnpm start -- --hub-host hub.example.com --hub-port 64739

# 生成默认配置文件
pnpm start generate-config --output ./config/edge-server.json

# 验证配置文件
pnpm start validate-config --config ./config/edge-server.json
```

## 架构说明

### 核心组件

- **EdgeServer**: 主服务器类，协调所有组件
- **ClientManager**: 客户端连接管理
- **ChannelManager**: 频道结构管理
- **MessageHandler**: Mumble 协议消息处理
- **VoiceRouter**: 语音包路由和转发
- **AuthManager**: 用户认证管理
- **HubClient**: 与 Hub Server 的连接
- **PeerManager**: P2P 对等连接管理

### 安全组件

- **BanManager**: 封禁管理系统
- **GeoIPManager**: 地理位置查询
- **ContextActions**: 右键菜单系统

### 性能组件

- **UserCache**: 用户信息缓存
- **PacketConnPool**: UDP 连接池
- **UDPMonitor**: 网络质量监控

## API 参考

### EdgeServer 类

```typescript
import { EdgeServer, loadEdgeConfig } from '@munode/edge-server';

// 加载配置
const config = loadEdgeConfig('./config/edge-server.json');

// 创建服务器
const server = new EdgeServer(config);

// 启动服务器
await server.start();

// 获取统计信息
const stats = server.getStats();

// 停止服务器
await server.stop();
```

### 事件

```typescript
server.on('clientConnected', (client) => {
  console.log(`Client connected: ${client.username}`);
});

server.on('clientDisconnected', (client) => {
  console.log(`Client disconnected: ${client.username}`);
});

server.on('voicePacket', (packet) => {
  console.log(`Voice packet received from ${packet.senderSession}`);
});
```

## 部署

### Docker 部署

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
EXPOSE 64738/udp 64738/tcp

CMD ["npm", "start"]
```

### 系统服务

创建 systemd 服务文件 `/etc/systemd/system/edge-server.service`:

```ini
[Unit]
Description=Mumble Edge Server
After=network.target

[Service]
Type=simple
User=mumble
Group=mumble
WorkingDirectory=/opt/edge-server
ExecStart=/usr/bin/node dist/cli.js start --config /etc/edge-server/config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 监控

服务器提供以下监控指标：

- 连接客户端数量
- 频道数量
- CPU 和内存使用率
- 带宽统计
- UDP 连接质量
- 缓存命中率

## 故障排除

### 常见问题

1. **连接失败**: 检查防火墙设置和端口配置
2. **认证失败**: 验证外部 API 配置和网络连接
3. **性能问题**: 检查 UDP 连接池和缓存配置
4. **集群问题**: 验证 Hub Server 连接和证书配置

### 日志级别

设置环境变量控制日志级别：

```bash
LOG_LEVEL=debug pnpm start
```

日志级别: `error`, `warn`, `info`, `debug`

## 贡献

请遵循以下步骤贡献代码：

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

MIT License - 查看 [LICENSE](../LICENSE) 文件了解详情