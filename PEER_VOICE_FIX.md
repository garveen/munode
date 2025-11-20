# Peer连接语音传输修复

## 问题描述

在之前的实现中，Edge服务器之间错误地使用RPC连接（PeerManager/ControlChannelClient）来转发语音包。这违反了架构设计原则：

**错误做法**：
- 通过 `peerManager.notifyPeer('voice.broadcastToChannel', ...)` 发送语音包
- 语音数据通过RPC控制信道传输
- 监听 `peer-notification` 事件来接收语音包

**架构原则**：
- **Edge之间的语音包应该通过UDP直接传输**，不应该经过RPC连接
- Peer连接（ControlChannelClient）仅用于控制信令（集群协调、状态同步等）
- VoiceUDPTransport 专门用于Edge之间的语音包直接传输

## 修复内容

### 1. 移除错误的Peer语音转发代码

**文件**: `packages/edge-server/src/edge-server.ts`

**删除的代码**:
```typescript
// 错误：通过peerManager的RPC连接转发语音
this.voiceRouter.on('broadcastToChannel', (channel_id, broadcast, _excludeSession) => {
  if (this.config.mode === 'cluster' && this.clusterManager) {
    const peerManager = this.clusterManager.getPeerManager();
    const connectedPeers = peerManager.getConnectedPeerIds();
    
    for (const peerId of connectedPeers) {
      peerManager.notifyPeer(peerId, 'voice.broadcastToChannel', {
        channel_id,
        sender_edge_id: this.config.server_id,
        sender_session: broadcast.sender_id,
        voice_packet: broadcast.packet.toString('base64'),
        timestamp: broadcast.timestamp,
      });
    }
  }
});

// 错误：通过peer-notification接收语音
peerManager.on('peer-notification', (_peerId, message) => {
  if (message.method === 'voice.broadcastToChannel') {
    this.handleVoiceBroadcastFromPeer(message.params);
  }
});
```

### 2. 使用VoiceUDPTransport直接传输语音

**新的实现**:
```typescript
// 正确：通过UDP直接广播到其他Edge
this.voiceRouter.on('broadcastToChannel', (channel_id, broadcast, _excludeSession) => {
  if (this.config.mode === 'cluster' && this.voiceTransport) {
    const voicePacket = {
      version: 1,
      senderId: broadcast.sender_id,
      targetId: 0, // 频道广播
      sequence: 0,
      codec: 0,
    };
    
    // broadcast.packet 已经是完整的Mumble格式语音包
    // (header+session+sequence+voice_data)
    this.voiceTransport.broadcast(voicePacket, broadcast.packet, this.config.server_id);
    
    logger.debug(`Forwarded voice broadcast via UDP to all peers for channel ${channel_id}`);
  }
});

// 正确：直接监听UDP接收的语音包
this.voiceTransport.on('voice-packet', (packetData: { header: any; voiceData: Buffer }) => {
  const { header, voiceData } = packetData;
  
  if (header.targetId === 0) {
    // 频道广播
    this.handleRemoteChannelVoiceBroadcast(voiceData);
  } else if (header.targetId === 0xFFFFFFFF) {
    // 服务器广播
    this.handleRemoteServerVoiceBroadcast(voiceData);
  }
});
```

### 3. 注册其他Edge的语音端口

**文件**: `packages/edge-server/src/edge-server.ts`

连接到Hub后，自动注册其他Edge的语音端口到VoiceUDPTransport：

```typescript
// Hub连接成功后，注册已存在的Edge语音端口
if (this.voiceTransport && this.clusterManager) {
  const clusterStatus = this.clusterManager.getStatus();
  const peers = clusterStatus.peerStats?.peerDetails || [];
  
  for (const peer of peers) {
    if (peer.connected) {
      const peerInfo = this.clusterManager.getPeerManager().getPeerInfo(peer.peerId);
      if (peerInfo && peerInfo.voicePort) {
        this.voiceTransport.registerEndpoint(peerInfo.id, peerInfo.host, peerInfo.voicePort);
      }
    }
  }
}

// 监听新Edge加入，注册其语音端口
this.hubClient.on('edgeJoined', (data) => {
  if (this.voiceTransport && data.voicePort) {
    this.voiceTransport.registerEndpoint(data.server_id, data.host, data.voicePort);
  }
});

// 监听Edge离开，移除其语音端口
this.hubClient.on('edgeLeft', (data) => {
  if (this.voiceTransport) {
    this.voiceTransport.unregisterEndpoint(data.server_id);
  }
});
```

### 4. 添加处理远程UDP语音包的方法

**新增方法**:

- `handleRemoteChannelVoiceBroadcast(voiceData)`: 处理来自其他Edge的频道语音广播
- `handleRemoteServerVoiceBroadcast(voiceData)`: 处理来自其他Edge的服务器广播
- `parseSessionFromVoicePacket(data)`: 从语音包中解析session ID

### 5. 更新PeerManager文档

**文件**: `packages/edge-server/src/control/peer-manager.ts`

在文件头部添加了明确的注释：

```typescript
/**
 * Peer连接管理器
 *
 * 管理Edge服务器之间的RPC连接（控制信道）：
 * - 建立和维护Edge-Edge RPC连接
 * - 处理Peer断开和重连
 * - 提供Peer连接状态查询
 * 
 * 注意：Peer连接仅用于控制信令（如集群协调、状态同步等），
 * 不应该用于语音包传输。语音包应该通过UDP直接传输（VoiceUDPTransport）。
 */
```

## 架构对比

### 修复前（错误）
```
Client A (Edge1) 
  -> VoiceRouter 
  -> peerManager.notifyPeer() 
  -> RPC连接
  -> Edge2 peer-notification handler
  -> Client B (Edge2)
```

**问题**:
- 语音包通过TCP RPC连接传输，增加延迟
- RPC连接不是为高频语音流设计的
- base64编码增加CPU开销和带宽

### 修复后（正确）
```
Client A (Edge1) 
  -> VoiceRouter 
  -> VoiceUDPTransport.broadcast() 
  -> UDP直连
  -> Edge2 VoiceUDPTransport (UDP监听)
  -> Client B (Edge2)
```

**优点**:
- UDP低延迟，适合实时语音
- 直接传输，无需额外编码
- 专用语音端口，不占用控制信道

## 待完善功能

1. **Session到Channel的全局映射**
   - 当前Edge只知道本地用户的channel
   - 需要从Hub查询远程session所在的channel
   - 才能正确将远程语音包转发给监听该频道的本地用户

2. **语音包序列号管理**
   - 当前序列号写死为0
   - 需要为每个发送端维护独立的序列号计数器

3. **Codec信息传递**
   - 当前codec写死为0
   - 需要从VoiceRouter的broadcast中获取实际的codec类型

4. **UDP加密**
   - VoiceUDPTransport支持加密
   - 需要在集群初始化时配置共享密钥

## 测试建议

1. **单元测试**
   - 测试VoiceUDPTransport的endpoint注册/注销
   - 测试语音包的encode/decode

2. **集成测试**
   - 启动2个Edge + 1个Hub
   - 验证Edge之间能否成功注册语音端口
   - 测试跨Edge的语音广播

3. **性能测试**
   - 对比UDP vs RPC传输的延迟
   - 测试大量并发语音流的处理能力

## 总结

这次修复纠正了Edge之间语音传输的根本性架构错误，确保：

1. ✅ Peer连接（RPC）只用于控制信令
2. ✅ 语音包通过UDP直接传输
3. ✅ 自动管理Edge语音端口的注册
4. ✅ 代码符合架构设计原则

语音传输现在走正确的UDP通道，不再污染RPC控制信道。
