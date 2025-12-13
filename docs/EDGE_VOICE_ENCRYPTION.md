# Edge间语音UDP传输加密实现文档

## 概述

本文档描述了 MuNode 中 Edge 服务器之间语音 UDP 传输的加密实现。该实现确保了分布式架构下 Edge 节点间的语音数据安全传输。

## 架构设计

### 密钥管理架构

```
┌─────────────────┐
│   Hub Server    │
│                 │
│  ┌───────────┐  │
│  │ Encryption│  │
│  │  Manager  │  │
│  └─────┬─────┘  │
└────────┼────────┘
         │ 分发密钥
    ┌────┼────┐
    │    │    │
    ▼    ▼    ▼
  Edge Edge Edge
   #1   #2   #3
```

### 组件说明

#### Hub 端组件

1. **VoiceEncryptionManager** (`packages/hub-server/src/voice-encryption-manager.ts`)
   - 生成和管理加密密钥
   - 支持密钥轮换
   - 跟踪每个 Edge 的密钥版本
   - 密钥分发给新加入的 Edge

2. **ControlService** (`packages/hub-server/src/control-service.ts`)
   - 集成 VoiceEncryptionManager
   - 在 Edge 注册时分发密钥
   - 推送语音路由配置（包含加密配置）

#### Edge 端组件

1. **VoiceUDPTransport** (`packages/protocol/src/voice/voice-udp-transport.ts`)
   - 合并了原 voice-packet.ts 的功能
   - 实现加密/解密逻辑
   - UDP 握手协议
   - 连接状态管理
   - 加密包缓存优化

2. **VoiceManager** (`packages/edge-server/src/managers/voice-manager.ts`)
   - 接收 Hub 推送的加密配置
   - 更新本地加密密钥
   - 处理连接失败通知

3. **EventSetupManager** (`packages/edge-server/src/managers/event-setup-manager.ts`)
   - 监听 `voiceRoutingConfig` 事件
   - 应用加密配置到 VoiceTransport

## 实现细节

### 1. 加密算法

支持的加密算法：
- **AES-128-CBC** (默认): 16 字节密钥
- **AES-256-CBC**: 32 字节密钥

加密格式：
```
[IV (16 bytes)] + [加密数据]
```

其中加密数据包含：
```
[version (1)] + [senderId (4)] + [targetId (4)] + [sequence (4)] + [codec (1)] + [voice_data (N)]
```

### 2. 密钥分发流程

```
Edge                          Hub
  │                            │
  ├──── register ─────────────>│
  │                            │ 生成/获取密钥
  │<──── RegisterResponse ─────┤ (包含密钥)
  │                            │
  ├──── join ─────────────────>│
  │                            │
  │<──── voiceRoutingConfig ───┤ (包含加密配置)
  │                            │
  │  应用加密密钥              │
  └─────────────────────────────
```

### 3. UDP 握手协议

Edge 间建立 UDP 连接时的三次握手：

```
Edge A                    Edge B
  │                         │
  ├───── SYN ──────────────>│
  │                         │
  │<──── SYN-ACK ───────────┤
  │                         │
  ├───── ACK ──────────────>│
  │                         │
  └─────────────────────────┘
     连接建立
```

握手包格式：
```
[Magic: "MUHS" (4 bytes)] + [Type (1 byte)] + [Timestamp (4 bytes)]
```

类型值：
- `1`: SYN
- `2`: SYN-ACK
- `3`: ACK

### 4. 性能优化

#### 加密包缓存

当同一个语音包需要发送给多个 Edge 时，加密操作只执行一次，加密后的包被缓存：

```typescript
// 缓存键：senderId-sequence
const cacheKey = `${packet.senderId}-${packet.sequence}`;
// 缓存时长：5 秒
setTimeout(() => this.encryptedPacketCache.delete(cacheKey), 5000);
```

这大大减少了 CPU 开销，特别是在有多个 Edge 节点的情况下。

### 5. 连接失败处理

```
Edge                          Hub
  │                            │
  │  尝试 UDP 握手             │
  │  (最多 5 次)               │
  │                            │
  │  所有尝试失败              │
  │                            │
  ├──── connectionFailure ────>│
  │                            │ 记录失败
  │                            │ 更新路由表
  │<──── 路由更新 ────────────┤
  └─────────────────────────────
```

## 配置

### Hub 配置

在 `config/hub.json` 中添加：

```json
{
  "voiceRouting": {
    "enabled": true,
    "encryption": {
      "algorithm": "aes-128-cbc",
      "keyRotationInterval": 3600
    }
  }
}
```

配置项说明：
- `algorithm`: 加密算法，可选 `aes-128-cbc` 或 `aes-256-cbc`
- `keyRotationInterval`: 密钥轮换间隔（秒），0 表示不轮换

### Edge 配置

Edge 不需要额外配置，加密密钥由 Hub 自动分发。

## 安全考虑

### 1. 密钥安全

- **生成**: 使用 `crypto.randomBytes()` 生成密钥
- **传输**: 通过 TLS 加密的控制通道传输
- **存储**: 仅存储在内存中，不持久化
- **轮换**: 支持定期轮换密钥

### 2. 加密强度

- **IV**: 每个包使用随机生成的 IV
- **算法**: AES-CBC 模式，业界标准
- **密钥长度**: 128 位或 256 位

### 3. 防止攻击

- **重放攻击**: 通过序列号和时间戳防止
- **中间人攻击**: TLS 控制通道防止密钥泄露
- **暴力破解**: 密钥长度足够，轮换频率合理

## 测试

### 集成测试

位置：`tests/integration/suites/edge-voice-encryption.test.ts`

测试内容：
1. 密钥分发验证
2. UDP 握手建立
3. 密钥更新功能
4. 连接状态跟踪

运行测试：
```bash
pnpm test:integration tests/integration/suites/edge-voice-encryption.test.ts
```

### 性能测试

TODO: 添加加密性能基准测试

预期性能影响：
- 加密延迟：< 1ms
- CPU 开销：< 5% (有缓存)
- 内存开销：< 100 MB (1000 并发连接)

## 故障排查

### 常见问题

1. **Edge 无法接收密钥**
   - 检查 Hub 配置中是否启用了 voiceRouting.encryption
   - 查看 Hub 日志确认密钥分发
   - 确认 Edge 与 Hub 的控制通道连接正常

2. **UDP 握手失败**
   - 检查防火墙设置
   - 确认 NAT 配置
   - 查看 Edge 日志中的握手尝试记录

3. **语音包解密失败**
   - 确认所有 Edge 使用相同版本的密钥
   - 检查是否存在网络包损坏
   - 验证加密算法配置一致

### 日志级别

调试时可设置日志级别为 `debug`：

```json
{
  "logLevel": "debug"
}
```

关键日志消息：
- `Generated new voice encryption key`: Hub 生成新密钥
- `Assigned encryption key to Edge`: Hub 分发密钥
- `Updated voice encryption key`: Edge 应用密钥
- `UDP handshake complete with Edge`: 握手成功

## 未来改进

1. **密钥协商**: 实现 Diffie-Hellman 密钥交换
2. **完美前向保密**: 为每个会话生成独立密钥
3. **算法升级**: 支持 AES-GCM、ChaCha20-Poly1305
4. **硬件加速**: 利用 CPU AES-NI 指令
5. **端到端加密**: 客户端到客户端的加密（当前是 Edge 到 Edge）

## 参考资料

- [AES-CBC 模式](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation#CBC)
- [Node.js Crypto API](https://nodejs.org/api/crypto.html)
- [Mumble Protocol](https://mumble-protocol.readthedocs.io/)
