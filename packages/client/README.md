# @munode/client

无头 Mumble 客户端，支持通过多种接口（HTTP API、WebSocket、Node.js API）控制和监听。

## 特性

- 🎯 **多接口支持**: HTTP REST API、WebSocket、Node.js API
- 🎤 **完整音频支持**: Opus 编解码、音频流管理、多格式转换
- 🔐 **安全认证**: 用户名密码、证书认证、访问令牌
- 📡 **实时事件**: WebSocket 双向通信、Webhook 推送
- 🎛️ **灵活控制**: 频道管理、用户操作、权限控制
- 🤖 **机器人友好**: 专为自动化、监控、集成场景设计

## 快速开始

### 安装

```bash
pnpm install @munode/client
```

### Node.js API

```typescript
import { MumbleClient } from '@munode/client';

const client = new MumbleClient();

// 连接到服务器
await client.connect({
  host: 'mumble.example.com',
  port: 64738,
  username: 'MyBot',
  password: 'password123'
});

// 监听事件
client.on('connected', () => {
  console.log('Connected to server');
});

client.on('message', (message) => {
  console.log(`Message from ${message.actor}: ${message.message}`);
});

// 加入频道
await client.joinChannel(1);

// 发送消息
await client.sendMessage({ channelId: 1 }, 'Hello, world!');

// 发送音频
await client.sendAudio({
  data: './audio.wav',
  format: 'auto'
});
```

### HTTP REST API

启动 HTTP 服务器：

```typescript
import { startHttpServer } from '@munode/client/api';

await startHttpServer({
  port: 3000,
  client: client
});
```

API 调用示例：

```bash
# 连接到服务器
curl -X POST http://localhost:3000/client/connect \
  -H "Content-Type: application/json" \
  -d '{"host": "mumble.example.com", "username": "MyBot"}'

# 发送消息
curl -X POST http://localhost:3000/message/send \
  -H "Content-Type: application/json" \
  -d '{"channelId": 1, "message": "Hello from API"}'

# 获取频道列表
curl http://localhost:3000/channel/list
```

### WebSocket 接口

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

// 连接命令
ws.send(JSON.stringify({
  type: 'command',
  id: '1',
  action: 'connect',
  data: {
    host: 'mumble.example.com',
    username: 'MyBot'
  }
}));

// 监听事件
ws.on('message', (data) => {
  const event = JSON.parse(data);
  console.log('Event:', event);
});
```

## 配置

配置文件示例 (`config/client.json`):

```json
{
  "connection": {
    "host": "mumble.example.com",
    "port": 64738,
    "autoReconnect": true,
    "reconnectDelay": 5000
  },
  "auth": {
    "username": "MyBot",
    "password": "password123"
  },
  "audio": {
    "encoder": {
      "codec": "opus",
      "bitrate": 40000,
      "frameSize": 20,
      "vbr": true
    }
  },
  "api": {
    "http": {
      "enabled": true,
      "port": 3000
    },
    "websocket": {
      "enabled": true,
      "path": "/ws"
    }
  }
}
```

## 文档

- [API 文档](./docs/API.md)
- [WebSocket 协议](./docs/WEBSOCKET.md)
- [音频处理](./docs/AUDIO.md)
- [配置说明](./docs/CONFIG.md)

## 许可证

MIT
