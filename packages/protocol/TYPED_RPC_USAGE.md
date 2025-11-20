# 类型安全的 RPC 系统使用指南

本文档介绍如何使用 `@munode/protocol` 包提供的类型安全 RPC 系统。

## 概述

新的类型安全 RPC 系统通过 TypeScript 的类型推断，让 Hub 和 Edge 之间的通信完全类型安全，避免运行时类型错误。

## 主要特性

- ✅ **方法名自动推断**：根据方法名自动推断参数和返回值类型
- ✅ **编译时类型检查**：在编译时捕获类型错误
- ✅ **自动完成支持**：IDE 自动提示可用的方法和参数
- ✅ **零运行时开销**：纯类型定义，不影响运行时性能

## Edge 端使用（客户端）

### 基本使用

```typescript
import { ControlChannelClient, TypedRPCClient, createTypedRPCClient } from '@munode/protocol';

// 创建控制通道客户端
const controlClient = new ControlChannelClient({
  host: 'hub.example.com',
  port: 8443,
});

// 等待连接建立
await controlClient.connect();

// 创建类型安全的 RPC 客户端
const typedClient = createTypedRPCClient(controlClient.getChannel());

// 现在可以进行类型安全的 RPC 调用
```

### 注册 Edge 服务器

```typescript
// TypeScript 会自动推断参数类型
const result = await typedClient.call('edge.register', {
  serverId: 1,
  name: 'edge-server-1',
  host: '192.168.1.100',
  port: 8080,
  region: 'us-west',
  capacity: 100,
  certificate: 'cert-data',
  metadata: {
    version: '1.0.0',
  },
});

// result 的类型自动推断为 RegisterResponse
console.log(result.success); // boolean
console.log(result.hubServerId); // number
console.log(result.edgeList); // EdgeInfo[]
```

### 发送心跳

```typescript
const heartbeatResult = await typedClient.call('edge.heartbeat', {
  serverId: 1,
  stats: {
    userCount: 10,
    channelCount: 5,
    cpuUsage: 45.2,
    memoryUsage: 2048,
    bandwidth: {
      in: 1024000,    // 注意：字段名是 in 和 out，不是 inBytes 和 outBytes
      out: 2048000,
    },
  },
});

// heartbeatResult: HeartbeatResponse
console.log(heartbeatResult.success);
console.log(heartbeatResult.updatedEdges); // EdgeInfo[] | undefined
```

### 获取频道列表

```typescript
// 空参数的方法
const channelsResult = await typedClient.call('edge.getChannels', {});

// channelsResult: ChannelsResponse
console.log(channelsResult.success);
console.log(channelsResult.channels); // ChannelData[]

channelsResult.channels.forEach((channel) => {
  console.log(channel.id, channel.name, channel.parentId);
});
```

### 保存频道

```typescript
const saveResult = await typedClient.call('edge.saveChannel', {
  channel: {
    name: 'New Channel',
    parent_id: 0,
    position: 0,
    max_users: 10,
    inherit_acl: 1,
    description_blob: 'Channel description',
    managed: 1,
  },
});

// saveResult: SaveChannelResponse
console.log(saveResult.channelId); // number
```

### 加入集群

```typescript
const joinResult = await typedClient.call('edge.join', {
  serverId: 1,
  name: 'edge-server-1',
  host: '192.168.1.100',
  port: 8080,
  voicePort: 8081,
  capacity: 100,
});

// joinResult 的类型自动推断
console.log(joinResult.token); // string
console.log(joinResult.peers); // Array<{ id, name, host, port, voicePort }>
console.log(joinResult.timeout); // number

// 连接到所有 peers
for (const peer of joinResult.peers) {
  await connectToPeer(peer.host, peer.port);
}
```

## Hub 端使用（服务器端）

### 设置类型安全的处理器

```typescript
import {
  ControlChannelServer,
  TypedRPCServer,
  createTypedRPCServer,
  RPCChannel,
  RPCParams,
  RPCResult,
} from '@munode/protocol';

// 创建控制通道服务器
const server = new ControlChannelServer({
  port: 8443,
  host: '0.0.0.0',
});

// 创建类型安全的 RPC 服务器
const typedServer = createTypedRPCServer();

// 注册处理器
setupHandlers(typedServer);

// 在收到请求时调用处理器
server.on('request', (channel, message, respond) => {
  if (message.method) {
    typedServer.handleRequest(
      channel,
      { method: message.method, params: message.params },
      respond
    );
  }
});
```

### 注册类型安全的处理器

```typescript
function setupHandlers(typedServer: TypedRPCServer) {
  // 处理 Edge 注册
  typedServer.handle('edge.register', async (channel, params) => {
    // params 类型自动推断为 RPCParams<'edge.register'>
    // 返回值必须符合 RPCResult<'edge.register'>
    
    console.log(params.serverId, params.name, params.host);
    
    // 执行注册逻辑
    const result = await registerEdge(params);
    
    // 返回类型安全的响应
    return {
      success: true,
      hubServerId: 1,
      edgeList: [],
    };
  });

  // 处理心跳
  typedServer.handle('edge.heartbeat', async (channel, params) => {
    console.log(`Heartbeat from Edge ${params.serverId}`);
    console.log(`Users: ${params.stats.userCount}`);
    
    // 更新统计信息
    updateEdgeStats(params.serverId, params.stats);
    
    return {
      success: true,
      updatedEdges: [],
    };
  });

  // 处理频道获取
  typedServer.handle('edge.getChannels', async (channel, params) => {
    // params 是空对象 Record<string, never>
    const channels = await database.getAllChannels();
    
    return {
      success: true,
      channels: channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        parentId: ch.parent_id,
        // ... 其他字段
      })),
    };
  });

  // 处理集群加入
  typedServer.handle('edge.join', async (channel, params) => {
    const allEdges = await getActiveEdges();
    const peers = allEdges
      .filter((e) => e.serverId !== params.serverId)
      .map((e) => ({
        id: e.serverId,
        name: e.name,
        host: e.host,
        port: e.port,
        voicePort: e.voicePort,
      }));
    
    return {
      success: true,
      token: `token-${params.serverId}-${Date.now()}`,
      peers,
      timeout: 60000,
    };
  });
}
```

### 发送类型安全的通知

```typescript
// 发送语音数据通知给特定 Edge
typedServer.notify(channel, 'voice.data', {
  fromSessionId: 1,
  targetSessionId: 2,
  voiceData: Buffer.from([]),
  timestamp: Date.now(),
});

// 广播新成员加入通知
const channels = getAllConnectedChannels();
typedServer.broadcast(channels, 'edge.peerJoined', {
  id: 2,
  name: 'edge-server-2',
  host: '192.168.1.101',
  port: 8080,
  voicePort: 8081,
});
```

## 类型系统架构

### RPC 方法定义

所有 RPC 方法都在 `rpc-types.ts` 中定义：

```typescript
export interface EdgeRegisterMethod {
  method: 'edge.register';
  params: {
    serverId: number;
    name: string;
    // ... 其他参数
  };
  result: RegisterResponse;
}
```

### 类型映射

```typescript
// 方法名到类型的映射
export type RPCMethodMap = {
  [K in EdgeToHubMethods as K['method']]: K;
};

// 根据方法名获取参数类型
export type RPCParams<M extends EdgeToHubMethods['method']> = 
  RPCMethodMap[M]['params'];

// 根据方法名获取返回类型
export type RPCResult<M extends EdgeToHubMethods['method']> = 
  RPCMethodMap[M]['result'];
```

## 所有可用的 RPC 方法

### Edge -> Hub 方法

- `edge.register` - 注册 Edge 服务器
- `edge.heartbeat` - 发送心跳
- `edge.reportSession` - 上报用户会话
- `edge.syncVoiceTarget` - 同步语音目标配置
- `edge.getVoiceTargets` - 获取语音目标配置
- `edge.routeVoice` - 请求路由语音数据
- `edge.adminOperation` - 执行管理操作
- `edge.exchangeCertificates` - 交换证书
- `edge.fullSync` - 请求完全同步
- `edge.getChannels` - 获取频道列表
- `edge.getACLs` - 获取 ACL 列表
- `edge.saveChannel` - 保存频道
- `edge.saveACL` - 保存 ACL
- `edge.join` - 请求加入集群
- `edge.joinComplete` - 完成集群加入
- `edge.reportPeerDisconnect` - 报告 Peer 断开
- `cluster.getStatus` - 获取集群状态

### Hub -> Edge 通知

- `voice.data` - 语音数据通知
- `edge.forceDisconnect` - 强制断开连接通知
- `edge.peerJoined` - 新成员加入通知

## 错误处理

RPC 调用会自动处理错误，抛出包含错误信息的异常：

```typescript
try {
  const result = await typedClient.call('edge.register', {
    // ... params
  });
  console.log(result);
} catch (error) {
  console.error('RPC call failed:', error);
}
```

在服务器端，处理器中抛出的异常会自动转换为 RPC 错误响应：

```typescript
typedServer.handle('edge.saveChannel', async (channel, params) => {
  if (!params.channel.name) {
    throw new Error('Channel name is required');
  }
  // ... 正常处理
  return { success: true, channelId: 123 };
});
```

## 最佳实践

1. **始终使用类型安全的 API**：使用 `TypedRPCClient` 和 `TypedRPCServer` 而不是直接使用底层的 `RPCChannel`

2. **让 TypeScript 推断类型**：不需要手动注解参数和返回值类型，让 TypeScript 自动推断

3. **使用解构赋值**：充分利用 IDE 的自动完成功能

```typescript
const { channels } = await typedClient.call('edge.getChannels', {});
```

4. **保持类型定义同步**：修改 RPC 接口时，同时更新 `rpc-types.ts` 中的类型定义

5. **使用错误处理**：总是用 try-catch 包装 RPC 调用

## 迁移指南

如果你正在从旧的非类型安全的 RPC 系统迁移：

### 客户端迁移

旧代码：
```typescript
const result = await channel.call('edge.register', {
  serverId: 1,
  name: 'edge-1',
  // ... 可能遗漏某些必需字段
}) as any; // 需要类型断言
```

新代码：
```typescript
const result = await typedClient.call('edge.register', {
  serverId: 1,
  name: 'edge-1',
  // TypeScript 会提示所有必需字段
  // 不需要类型断言
});
```

### 服务器端迁移

旧代码：
```typescript
async handleEdgeRegister(channel: RPCChannel, params: any, respond: Function) {
  try {
    // 需要手动类型转换
    const typedParams = params as RegisterParams;
    // ... 处理逻辑
    respond({ success: true });
  } catch (error) {
    respond(undefined, { code: -32603, message: 'Error' });
  }
}
```

新代码：
```typescript
async handleEdgeRegister(
  channel: RPCChannel,
  params: RPCParams<'edge.register'>
): Promise<RPCResult<'edge.register'>> {
  // params 已经是正确的类型
  // 直接返回结果，错误会自动处理
  return {
    success: true,
    hubServerId: 1,
    edgeList: [],
  };
}
```

## 总结

使用类型安全的 RPC 系统可以：

- 在编译时捕获错误，而不是运行时
- 提供更好的 IDE 支持和自动完成
- 减少文档需求，代码即文档
- 提高代码可维护性和重构安全性
