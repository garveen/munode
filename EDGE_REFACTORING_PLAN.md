# Edge Server 重构方案

*** 重要 ***
依据本文档进行重构时，每一步开始时标注开始，结束时标注结束

## 当前问题分析

### 1. 功能重复和冲突

#### 认证管理冲突
- **问题**: 
  - `auth-manager.ts` (src根目录) - 完整的认证管理器
  - `handlers/auth-handlers.ts` - 认证消息处理器
  - 职责不清晰，存在重复逻辑

#### 封禁管理冲突  
- **问题**:
  - `ban-manager.ts` (src根目录) - 完整的封禁系统，包含SQLite数据库
  - `managers/ban-handler.ts` - 封禁处理器
  - `state-manager.ts` 内部的 `BanCache` 类 - 轻量级封禁缓存
  - 三处封禁逻辑，功能重叠，不易维护

#### 消息处理冲突
- **问题**:
  - `message-handler.ts` (src根目录) - 基础消息路由
  - `managers/message-manager.ts` - 消息解析和管理
  - `handlers/message-handlers.ts` - 具体消息处理
  - `handlers/protocol-handlers.ts` - 协议相关处理
  - `handlers/state-handlers.ts` - 状态相关处理
  - `handlers/connection-handlers.ts` - 连接相关处理
  - `handlers/admin-handlers.ts` - 管理命令处理
  - 消息处理逻辑分散在多个文件，调用链路不清晰

#### 集群管理冲突
- **问题**:
  - `cluster-manager.ts` (src根目录) - 集群管理器
  - `peer-manager.ts` (src根目录) - P2P连接管理（已废弃但未删除）
  - `control/peer-manager.ts` - 另一个P2P管理器
  - `control/reconnect-manager.ts` - 重连管理
  - Edge之间通信架构已改为Hub中转，但旧的P2P代码仍存在

#### 语音路由冲突
- **问题**:
  - `voice-router.ts` (src根目录) - 语音路由器
  - `managers/voice-manager.ts` - 语音管理器
  - 职责划分不清，VoiceManager依赖VoiceRouter但功能重叠

#### 服务器生命周期混乱
- **问题**:
  - `edge-server.ts` (主服务器实现)
  - `edge-server.original.ts` (旧版本，应删除)
  - `managers/server-lifecycle-manager.ts` - 生命周期管理
  - `lifecycle/disconnect-handler.ts` - 断线处理
  - 生命周期逻辑分散

### 2. 目录结构混乱

```
src/
├── auth-manager.ts              ❌ 应归类到 managers/
├── ban-manager.ts               ❌ 应归类到 managers/
├── channel.ts                   ❌ 应归类到 models/ 或 state/
├── client.ts                    ❌ 应归类到 managers/
├── cluster-manager.ts           ❌ 应归类到 cluster/
├── edge-control-client.ts       ❌ 应归类到 cluster/
├── edge-server.original.ts      ❌ 废弃文件，应删除
├── edge-server.ts               ✅ 主入口
├── geoip-manager.ts             ❌ 应归类到 managers/
├── handler-factory.ts           ⚠️  需要重构
├── message-handler.ts           ❌ 应整合到 handlers/
├── packet-pool.ts               ❌ 应归类到 network/
├── peer-manager.ts              ❌ 废弃，应删除
├── state-manager.ts             ❌ 应归类到 state/
├── udp-monitor.ts               ❌ 应归类到 network/
├── user-cache.ts                ❌ 应归类到 cache/ 或 state/
├── voice-router.ts              ❌ 应归类到 voice/
├── config.ts                    ✅ 配置加载
├── types.ts                     ✅ 类型定义
├── context-actions.ts           ⚠️  需要明确归属
├── cli.ts                       ✅ CLI入口
├── index.ts                     ✅ 导出入口
├── control/                     ⚠️  应重命名为 cluster/
│   ├── peer-manager.ts          ❌ 废弃，应删除
│   └── reconnect-manager.ts     ✅ 保留
├── handlers/                    ⚠️  需要重组
│   ├── admin-handlers.ts        ✅ 管理命令
│   ├── auth-handlers.ts         ✅ 认证处理
│   ├── connection-handlers.ts   ✅ 连接处理
│   ├── hub-message-handlers.ts  ✅ Hub消息处理
│   ├── message-handlers.ts      ✅ 通用消息处理
│   ├── permission-handlers.ts   ✅ 权限处理
│   ├── protocol-handlers.ts     ✅ 协议处理
│   └── state-handlers.ts        ✅ 状态处理
├── lifecycle/                   ⚠️  功能单一
│   └── disconnect-handler.ts
└── managers/                    ⚠️  需要重组
    ├── ban-handler.ts           ❌ 与 ban-manager.ts 重复
    ├── event-setup-manager.ts   ✅ 事件设置
    ├── hub-data-manager.ts      ✅ Hub数据管理
    ├── message-manager.ts       ⚠️  与 message-handler.ts 重叠
    ├── server-lifecycle-manager.ts  ✅ 生命周期
    └── voice-manager.ts         ⚠️  与 voice-router.ts 重叠
```

---

## 重构方案

### 核心原则

1. **单一职责**: 每个模块只负责一个明确的功能领域
2. **清晰分层**: 区分核心逻辑、业务逻辑、网络层
3. **依赖注入**: 通过构造函数或工厂模式注入依赖
4. **避免循环依赖**: 使用事件或接口解耦
5. **删除废弃代码**: 移除不再使用的P2P相关代码

---

## 新的目录结构

```
packages/edge-server/src/
│
├── index.ts                      # 主入口，导出公共API
├── cli.ts                        # CLI入口
├── types.ts                      # 全局类型定义
├── config.ts                     # 配置加载和验证
│
├── core/                         # 核心服务器类
│   ├── edge-server.ts            # EdgeServer主类（简化，协调各模块）
│   ├── handler-factory.ts        # 依赖注入工厂（重构）
│   └── lifecycle-manager.ts      # 服务器生命周期管理
│
├── network/                      # 网络层
│   ├── tcp-listener.ts           # TCP服务器监听
│   ├── udp-listener.ts           # UDP语音监听
│   ├── packet-pool.ts            # 数据包池（内存管理）
│   ├── udp-monitor.ts            # UDP连接监控
│   └── protocol.ts               # Mumble协议编解码
│
├── client/                       # 客户端管理
│   ├── client-manager.ts         # 客户端连接管理（from client.ts）
│   ├── client-state.ts           # 客户端状态模型
│   └── client-crypto.ts          # 客户端加密状态
│
├── auth/                         # 认证授权
│   ├── auth-manager.ts           # 认证管理器（主逻辑）
│   ├── auth-handler.ts           # 认证消息处理
│   └── permission-checker.ts     # 权限检查（from permission-handlers.ts）
│
├── state/                        # 状态管理
│   ├── state-manager.ts          # Edge状态管理（频道、ACL）
│   ├── channel-tree.ts           # 频道树构建
│   ├── user-cache.ts             # 用户缓存
│   └── remote-user-tracker.ts    # 远程用户追踪（优化）
│
├── ban/                          # 封禁系统
│   ├── ban-manager.ts            # 封禁管理器（持久化 + 缓存）
│   ├── ban-cache.ts              # 高性能封禁缓存（从state-manager提取）
│   └── ban-checker.ts            # 封禁检查接口
│
├── cluster/                      # 集群通信（重命名from control/）
│   ├── cluster-manager.ts        # 集群管理（简化）
│   ├── hub-client.ts             # Hub连接客户端（from edge-control-client.ts）
│   ├── hub-data-sync.ts          # Hub数据同步（from managers/hub-data-manager.ts）
│   ├── reconnect-manager.ts      # 重连管理
│   └── hub-message-handler.ts    # Hub消息处理（from handlers/hub-message-handlers.ts）
│
├── voice/                        # 语音路由
│   ├── voice-router.ts           # 语音路由器（核心逻辑）
│   ├── voice-transport.ts        # UDP语音传输（封装VoiceUDPTransport）
│   ├── voice-target.ts           # 语音目标管理
│   └── voice-crypto.ts           # 语音加密管理
│
├── handlers/                     # 消息处理器（按功能分组）
│   ├── index.ts                  # 统一导出
│   ├── message-dispatcher.ts     # 消息分发器（整合message-handler.ts）
│   ├── message-parser.ts         # 消息解析（from managers/message-manager.ts）
│   ├── connection.ts             # 连接处理（Version、Authenticate、Ping）
│   ├── channel.ts                # 频道操作（ChannelState、ChannelRemove）
│   ├── user.ts                   # 用户操作（UserState、UserRemove）
│   ├── text-message.ts           # 文本消息处理
│   ├── admin.ts                  # 管理命令（BanList、UserList、ACL）
│   ├── voice-target.ts           # 语音目标设置
│   ├── context-action.ts         # 右键菜单（from context-actions.ts）
│   └── protocol-misc.ts          # 其他协议消息（CodecVersion、QueryUsers等）
│
├── util/                         # 工具类
│   ├── geoip-manager.ts          # GeoIP查询
│   ├── logger.ts                 # 日志工具
│   └── event-emitter.ts          # 事件管理工具
│
└── models/                       # 数据模型（可选）
    ├── channel.ts                # 频道数据模型
    ├── user.ts                   # 用户数据模型
    └── acl.ts                    # ACL数据模型
```

---

## 详细重构步骤

### 第一阶段：清理废弃代码

**删除文件**:
- `src/edge-server.original.ts` - 旧版本
- `src/peer-manager.ts` - 已废弃的P2P管理器
- `src/control/peer-manager.ts` - 另一个废弃的P2P管理器

**操作**:
```bash
rm src/edge-server.original.ts
rm src/peer-manager.ts
rm src/control/peer-manager.ts
```

---

### 第二阶段：创建新目录结构

**创建目录**:
```bash
mkdir -p src/{core,network,client,auth,state,ban,cluster,voice,handlers,util,models}
```

---

### 第三阶段：模块重组和重构

#### 3.1 网络层 (network/)

**文件迁移和重构**:
- `packet-pool.ts` → `network/packet-pool.ts` (直接移动)
- `udp-monitor.ts` → `network/udp-monitor.ts` (直接移动)
- 从 `edge-server.ts` 提取TCP/UDP监听逻辑 → `network/tcp-listener.ts`, `network/udp-listener.ts`
- 从 `message-handler.ts` 提取协议编解码 → `network/protocol.ts`

**新文件示例**:
```typescript
// network/tcp-listener.ts
export class TCPListener {
  constructor(
    private config: EdgeConfig,
    private clientManager: ClientManager,
    private messageParser: MessageParser
  ) {}

  async start(): Promise<void> {
    this.server = tls.createServer(this.tlsOptions, (socket) => {
      this.handleNewConnection(socket);
    });
    // ...
  }
}
```

#### 3.2 客户端管理 (client/)

**文件迁移和重构**:
- `client.ts` → `client/client-manager.ts` (重命名 `ClientManager`)
- 提取 `ClientInfo` 类型 → `client/client-state.ts`
- 从 `voice-router.ts` 提取加密状态管理 → `client/client-crypto.ts`

**依赖关系**:
```typescript
// client/client-manager.ts
import { ClientState } from './client-state.js';
import { ClientCrypto } from './client-crypto.js';

export class ClientManager {
  private clients: Map<number, ClientState> = new Map();
  private cryptos: Map<number, ClientCrypto> = new Map();
  // ...
}
```

#### 3.3 认证授权 (auth/)

**文件迁移和重构**:
- `auth-manager.ts` → `auth/auth-manager.ts` (保留核心逻辑)
- `handlers/auth-handlers.ts` → `auth/auth-handler.ts` (消息处理)
- `handlers/permission-handlers.ts` → `auth/permission-checker.ts` (权限检查)

**职责划分**:
- `auth-manager.ts`: API调用、缓存、用户ID生成
- `auth-handler.ts`: 处理 Authenticate 消息，调用 AuthManager
- `permission-checker.ts`: ACL权限检查、操作权限验证

**示例**:
```typescript
// auth/auth-handler.ts
export class AuthHandler {
  constructor(
    private authManager: AuthManager,
    private clientManager: ClientManager
  ) {}

  async handleAuthenticate(session_id: number, data: Buffer): Promise<void> {
    const auth = mumbleproto.Authenticate.deserialize(data);
    const result = await this.authManager.authenticate(
      session_id, 
      auth.username, 
      auth.password, 
      auth.tokens
    );
    // 处理结果...
  }
}
```

#### 3.4 状态管理 (state/)

**文件迁移和重构**:
- `state-manager.ts` → `state/state-manager.ts`
  - 移除内部的 `BanCache` 类 → `ban/ban-cache.ts`
  - 提取频道树构建逻辑 → `state/channel-tree.ts`
  - 提取远程用户追踪 → `state/remote-user-tracker.ts`
- `user-cache.ts` → `state/user-cache.ts` (直接移动)
- `channel.ts` → `models/channel.ts` (数据模型)

**重构示例**:
```typescript
// state/state-manager.ts
import { ChannelTree } from './channel-tree.js';
import { RemoteUserTracker } from './remote-user-tracker.js';

export class StateManager {
  private channelTree: ChannelTree;
  private remoteUsers: RemoteUserTracker;
  private acls: Map<number, ACLData[]> = new Map();
  private configs: Map<string, string> = new Map();

  constructor() {
    this.channelTree = new ChannelTree();
    this.remoteUsers = new RemoteUserTracker();
  }

  loadSnapshot(snapshot: FullSnapshot): void {
    this.channelTree.build(snapshot.channels, snapshot.channelLinks);
    this.acls.clear();
    // ...
  }
}
```

#### 3.5 封禁系统 (ban/)

**文件迁移和重构**:
- `ban-manager.ts` → `ban/ban-manager.ts` (SQLite + 持久化)
- `managers/ban-handler.ts` → 删除或合并到 `ban-manager.ts`
- 从 `state-manager.ts` 提取 `BanCache` → `ban/ban-cache.ts` (高性能缓存)
- 新建 `ban/ban-checker.ts` (统一接口)

**职责划分**:
- `ban-manager.ts`: SQLite数据库操作、持久化、管理API
- `ban-cache.ts`: LRU缓存、快速IP/证书匹配、内存优化
- `ban-checker.ts`: 统一的封禁检查接口，整合 BanManager 和 BanCache

**示例**:
```typescript
// ban/ban-checker.ts
export class BanChecker {
  constructor(
    private banManager: BanManager,
    private banCache: BanCache
  ) {}

  async check(ip: string, certHash?: string): Promise<BanCheckResult> {
    // 1. 先查缓存（快速路径）
    const cacheResult = this.banCache.check(ip, certHash);
    if (cacheResult.banned) return cacheResult;

    // 2. 查数据库（完整检查）
    return await this.banManager.checkConnection(ip, certHash);
  }
}
```

#### 3.6 集群通信 (cluster/)

**文件迁移和重构**:
- `control/` 目录重命名为 `cluster/`
- `cluster-manager.ts` → `cluster/cluster-manager.ts` (简化)
- `edge-control-client.ts` → `cluster/hub-client.ts` (重命名)
- `control/reconnect-manager.ts` → `cluster/reconnect-manager.ts` (保留)
- `managers/hub-data-manager.ts` → `cluster/hub-data-sync.ts` (重命名)
- `handlers/hub-message-handlers.ts` → `cluster/hub-message-handler.ts` (移动)

**职责划分**:
- `cluster-manager.ts`: 协调集群加入、监控、故障恢复
- `hub-client.ts`: 底层Hub连接、RPC调用、事件处理
- `hub-data-sync.ts`: 处理Hub推送的快照和增量更新
- `reconnect-manager.ts`: 重连策略和状态机
- `hub-message-handler.ts`: 处理Hub发来的消息（用户状态、文本消息等）

#### 3.7 语音路由 (voice/)

**文件迁移和重构**:
- `voice-router.ts` → `voice/voice-router.ts` (核心路由逻辑)
- `managers/voice-manager.ts` → 删除或合并到 `voice-router.ts`
- 新建 `voice/voice-transport.ts` (封装 VoiceUDPTransport)
- 新建 `voice/voice-target.ts` (管理语音目标)
- 新建 `voice/voice-crypto.ts` (语音加密，从voice-router提取)

**职责划分**:
- `voice-router.ts`: 语音包路由、本地广播、频道/链接计算
- `voice-transport.ts`: UDP传输、跨Edge语音包发送/接收
- `voice-target.ts`: 语音目标管理（VoiceTarget协议）
- `voice-crypto.ts`: OCB2加密、解密、密钥管理

**重构示例**:
```typescript
// voice/voice-router.ts
export class VoiceRouter {
  constructor(
    private config: EdgeConfig,
    private stateManager: StateManager,
    private clientManager: ClientManager,
    private voiceCrypto: VoiceCrypto,
    private voiceTransport: VoiceTransport
  ) {}

  routeVoicePacket(session_id: number, packet: Buffer): void {
    // 1. 解密
    const decrypted = this.voiceCrypto.decrypt(session_id, packet);
    
    // 2. 计算目标（本地 + 远程）
    const targets = this.calculateTargets(session_id, decrypted);
    
    // 3. 本地广播
    this.broadcastLocally(targets.local, decrypted);
    
    // 4. 远程转发
    this.voiceTransport.sendToRemoteEdges(targets.remote, decrypted);
  }
}
```

#### 3.8 消息处理器 (handlers/)

**文件重组**:
- 删除 `message-handler.ts`（功能分散到各子模块）
- `managers/message-manager.ts` → `handlers/message-parser.ts` (解析TCP流)
- 新建 `handlers/message-dispatcher.ts` (路由消息到具体handler)
- `handlers/auth-handlers.ts` → `auth/auth-handler.ts` (移动到auth/)
- `handlers/message-handlers.ts` → `handlers/text-message.ts` (专注文本消息)
- `handlers/admin-handlers.ts` → `handlers/admin.ts` (重命名)
- `handlers/connection-handlers.ts` → `handlers/connection.ts` (重命名)
- `handlers/state-handlers.ts` → 拆分为 `handlers/channel.ts` 和 `handlers/user.ts`
- `handlers/protocol-handlers.ts` → `handlers/protocol-misc.ts` (其他协议)
- `handlers/permission-handlers.ts` → `auth/permission-checker.ts` (移动到auth/)
- `context-actions.ts` → `handlers/context-action.ts` (移动)

**新增统一入口**:
```typescript
// handlers/message-dispatcher.ts
export class MessageDispatcher {
  constructor(
    private connectionHandler: ConnectionHandler,
    private channelHandler: ChannelHandler,
    private userHandler: UserHandler,
    private textMessageHandler: TextMessageHandler,
    private adminHandler: AdminHandler,
    private voiceTargetHandler: VoiceTargetHandler,
    private contextActionHandler: ContextActionHandler,
    private protocolMiscHandler: ProtocolMiscHandler
  ) {}

  dispatch(session_id: number, messageType: number, data: Buffer): void {
    switch (messageType) {
      case MessageType.Version:
      case MessageType.Authenticate:
      case MessageType.Ping:
        this.connectionHandler.handle(session_id, messageType, data);
        break;
      case MessageType.ChannelState:
      case MessageType.ChannelRemove:
        this.channelHandler.handle(session_id, messageType, data);
        break;
      // ...
    }
  }
}
```

#### 3.9 核心服务器 (core/)

**文件迁移和重构**:
- `edge-server.ts` → `core/edge-server.ts` (简化，协调各模块)
- `handler-factory.ts` → `core/handler-factory.ts` (重构为DI容器)
- `managers/server-lifecycle-manager.ts` → `core/lifecycle-manager.ts`
- `lifecycle/disconnect-handler.ts` → 合并到 `core/lifecycle-manager.ts`

**EdgeServer 简化示例**:
```typescript
// core/edge-server.ts
export class EdgeServer {
  private tcpListener: TCPListener;
  private udpListener: UDPListener;
  private clusterManager: ClusterManager;
  private lifecycleManager: LifecycleManager;

  constructor(private config: EdgeConfig) {
    // 使用工厂创建所有依赖
    const factory = new HandlerFactory(config);
    
    this.tcpListener = factory.createTCPListener();
    this.udpListener = factory.createUDPListener();
    this.clusterManager = factory.createClusterManager();
    this.lifecycleManager = factory.createLifecycleManager();
  }

  async start(): Promise<void> {
    await this.lifecycleManager.startup([
      () => this.tcpListener.start(),
      () => this.udpListener.start(),
      () => this.clusterManager.joinCluster(),
    ]);
  }

  async stop(): Promise<void> {
    await this.lifecycleManager.shutdown([
      () => this.clusterManager.leaveCluster(),
      () => this.udpListener.stop(),
      () => this.tcpListener.stop(),
    ]);
  }
}
```

**HandlerFactory 重构**:
```typescript
// core/handler-factory.ts
export class HandlerFactory {
  private instances: Map<string, any> = new Map();

  constructor(private config: EdgeConfig) {}

  // 单例访问器
  get logger(): Logger {
    return this.getSingleton('logger', () => createLogger({ service: 'edge-server' }));
  }

  get clientManager(): ClientManager {
    return this.getSingleton('clientManager', () => 
      new ClientManager(this.config, this.logger)
    );
  }

  get stateManager(): StateManager {
    return this.getSingleton('stateManager', () => new StateManager());
  }

  get authManager(): AuthManager {
    return this.getSingleton('authManager', () => 
      new AuthManager(this.config, this.logger, this.userCache)
    );
  }

  get banManager(): BanManager {
    return this.getSingleton('banManager', () => 
      new BanManager(this.config.banDbPath, 1024)
    );
  }

  get banCache(): BanCache {
    return this.getSingleton('banCache', () => new BanCache());
  }

  get banChecker(): BanChecker {
    return this.getSingleton('banChecker', () => 
      new BanChecker(this.banManager, this.banCache)
    );
  }

  get voiceCrypto(): VoiceCrypto {
    return this.getSingleton('voiceCrypto', () => new VoiceCrypto());
  }

  get voiceTransport(): VoiceTransport {
    return this.getSingleton('voiceTransport', () => 
      new VoiceTransport(this.config, this.logger)
    );
  }

  get voiceRouter(): VoiceRouter {
    return this.getSingleton('voiceRouter', () => 
      new VoiceRouter(
        this.config,
        this.stateManager,
        this.clientManager,
        this.voiceCrypto,
        this.voiceTransport
      )
    );
  }

  // Handler创建
  createMessageDispatcher(): MessageDispatcher {
    return new MessageDispatcher(
      this.createConnectionHandler(),
      this.createChannelHandler(),
      this.createUserHandler(),
      this.createTextMessageHandler(),
      this.createAdminHandler(),
      this.createVoiceTargetHandler(),
      this.createContextActionHandler(),
      this.createProtocolMiscHandler()
    );
  }

  private createConnectionHandler(): ConnectionHandler {
    return new ConnectionHandler(
      this.authManager,
      this.clientManager,
      this.banChecker,
      this.geoipManager
    );
  }

  // ... 其他handler创建方法

  private getSingleton<T>(key: string, factory: () => T): T {
    if (!this.instances.has(key)) {
      this.instances.set(key, factory());
    }
    return this.instances.get(key) as T;
  }
}
```

#### 3.10 工具类 (util/)

**文件迁移**:
- `geoip-manager.ts` → `util/geoip-manager.ts`
- 新建 `util/logger.ts` (统一日志配置)
- 新建 `util/event-emitter.ts` (事件管理工具，如果需要)

---

## 模块依赖关系图

```
┌─────────────────────────────────────────────────────────────┐
│                        edge-server.ts                        │
│                    (主协调器，最小逻辑)                         │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────────┐
│                    handler-factory.ts                       │
│              (依赖注入容器，创建所有模块实例)                    │
└───┬────────────┬───────────┬───────────┬───────────┬────────┘
    │            │           │           │           │
    ▼            ▼           ▼           ▼           ▼
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ network │ │ client  │ │  auth   │ │  state  │ │   ban   │
│         │ │         │ │         │ │         │ │         │
│ • TCP   │ │ Manager │ │ Manager │ │ Manager │ │ Checker │
│ • UDP   │ │ • State │ │ Handler │ │ • Tree  │ │ Manager │
│ • Proto │ │ • Crypto│ │ Checker │ │ • ACL   │ │ • Cache │
└─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
    │            │           │           │           │
    └────────────┴───────────┴───────────┴───────────┘
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
          ┌─────────────┐           ┌───────────────┐
          │   cluster   │           │     voice     │
          │             │           │               │
          │ • Hub       │◄─────────►│ • Router      │
          │ • Sync      │           │ • Transport   │
          │ • Reconnect │           │ • Crypto      │
          └─────────────┘           └───────────────┘
                 │                           │
                 └──────────┬────────────────┘
                            ▼
                  ┌──────────────────┐
                  │     handlers     │
                  │                  │
                  │ • Dispatcher     │
                  │ • Connection     │
                  │ • Channel/User   │
                  │ • TextMessage    │
                  │ • Admin          │
                  └──────────────────┘
```

**依赖规则**:
- 箭头方向表示依赖关系（A → B 表示 A 依赖 B）
- `core/` 可以依赖任何模块
- `handlers/` 可以依赖 `client`, `auth`, `state`, `voice`, `cluster`
- `voice/` 可以依赖 `state`, `client`
- `cluster/` 可以依赖 `state`, `client`
- `network/`, `auth/`, `ban/`, `state/` 之间尽量避免直接依赖，通过事件或接口通信

---

## 重构实施计划

### 阶段一：准备工作（1天）
- [ ] 创建新目录结构
- [ ] 删除废弃文件（edge-server.original.ts, peer-manager.ts等）
- [ ] 更新 tsconfig.json 路径映射（如果需要）

### 阶段二：基础模块迁移（2-3天）
- [ ] 迁移 `network/` 模块（packet-pool, udp-monitor）
- [ ] 重构 `client/` 模块（client-manager, state, crypto）
- [ ] 迁移 `util/` 模块（geoip-manager）

### 阶段三：核心业务模块重构（3-4天）
- [ ] 重构 `auth/` 模块（合并 auth-manager 和 auth-handlers）
- [ ] 重构 `ban/` 模块（分离 BanManager 和 BanCache）
- [ ] 重构 `state/` 模块（提取 channel-tree, remote-user-tracker）

### 阶段四：集群和语音重构（2-3天）
- [ ] 重构 `cluster/` 模块（重命名control/, 整合hub相关逻辑）
- [ ] 重构 `voice/` 模块（分离 router, transport, crypto, target）

### 阶段五：消息处理重构（2-3天）
- [ ] 创建 `handlers/message-dispatcher.ts` 和 `message-parser.ts`
- [ ] 重组各个handler（connection, channel, user, text-message等）
- [ ] 删除旧的 message-handler.ts

### 阶段六：核心协调器重构（1-2天）
- [ ] 重构 `core/handler-factory.ts`（DI容器）
- [ ] 简化 `core/edge-server.ts`（协调器）
- [ ] 整合 `core/lifecycle-manager.ts`

### 阶段七：测试和验证（2-3天）
- [ ] 运行现有集成测试
- [ ] 修复所有测试错误
- [ ] 验证各功能模块正常工作
- [ ] 性能测试和优化

### 阶段八：文档更新（1天）
- [ ] 更新 README.md
- [ ] 更新架构文档
- [ ] 添加模块使用示例
- [ ] 更新 API 文档

**总预计时间**: 14-20天

---

## 迁移注意事项

### 1. 导入路径更新
重构后所有 import 路径都需要更新，建议使用 IDE 的重构功能或编写脚本批量替换。

**示例**:
```typescript
// 旧路径
import { AuthManager } from './auth-manager.js';
import { BanManager } from './ban-manager.js';

// 新路径
import { AuthManager } from './auth/auth-manager.js';
import { BanManager } from './ban/ban-manager.js';
```

### 2. 循环依赖处理
重构时注意避免循环依赖，使用以下策略：
- 使用事件解耦（EventEmitter）
- 依赖注入（构造函数注入）
- 接口抽象（定义接口而非直接依赖实现）

### 3. 测试覆盖
重构过程中保持测试覆盖：
- 先写测试再重构（如果原来没有测试）
- 保持现有测试通过
- 为新拆分的模块添加单元测试

### 4. 渐进式重构
- 不要一次性重构所有模块
- 每个阶段完成后运行测试验证
- 必要时可以保留旧代码一段时间，标记为 @deprecated

### 5. 配置兼容性
如果配置结构有变化，需要提供迁移工具或向后兼容：
```typescript
// 配置迁移示例
function migrateConfig(oldConfig: any): EdgeConfig {
  return {
    ...oldConfig,
    banDbPath: oldConfig.ban?.dbPath || './data/bans.db',
    // 处理其他配置迁移
  };
}
```

---

## 重构收益

### 1. 可维护性提升
- **清晰的职责划分**: 每个模块职责单一，易于理解和修改
- **减少代码重复**: 消除ban-manager、message-handler等重复逻辑
- **降低耦合度**: 通过接口和事件解耦，减少模块间依赖

### 2. 开发效率提升
- **易于定位问题**: 目录结构清晰，快速找到相关代码
- **便于并行开发**: 模块独立，多人协作不冲突
- **易于测试**: 小模块单元测试更容易编写

### 3. 扩展性提升
- **插件化架构**: 新功能可以作为独立模块添加
- **替换组件**: 例如可以轻松替换认证策略或封禁实现
- **协议扩展**: voice/和handlers/模块可独立扩展新协议

### 4. 性能优化空间
- **独立优化**: 可以针对voice/、ban/等性能敏感模块单独优化
- **资源隔离**: 网络层、状态层可以独立调优
- **缓存策略**: ban/、state/模块可以独立实现缓存策略

---

## 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 破坏现有功能 | 高 | 中 | 保持测试覆盖，渐进式重构 |
| 引入新bug | 中 | 高 | Code Review，集成测试 |
| 开发时间超期 | 中 | 中 | 分阶段交付，优先核心模块 |
| 团队学习曲线 | 低 | 低 | 详细文档，代码注释 |
| 配置不兼容 | 低 | 低 | 提供迁移工具 |

---

## 后续建议

### 1. 持续改进
- 定期审查模块职责，及时调整
- 添加性能监控，识别瓶颈
- 收集开发反馈，优化开发体验

### 2. 文档维护
- 保持架构文档与代码同步
- 为每个模块编写README
- 维护API文档和使用示例

### 3. 测试覆盖
- 提高单元测试覆盖率（目标80%+）
- 添加集成测试覆盖关键流程
- 性能测试和压力测试

### 4. 代码规范
- 统一命名规范
- 使用ESLint/Prettier强制代码风格
- Code Review流程

---

## 总结

本重构方案通过：
1. **删除废弃代码**（edge-server.original.ts, peer-manager.ts等）
2. **消除功能重复**（ban、message-handler、voice等）
3. **清晰的目录结构**（按功能领域分组）
4. **明确的职责划分**（单一职责原则）
5. **降低模块耦合**（依赖注入、事件驱动）

实现了一个**清晰、可维护、可扩展**的 Edge Server 架构。

重构后的代码将更易于：
- 新人理解和上手
- 定位和修复问题
- 添加新功能
- 进行性能优化
- 编写测试

建议采用**渐进式重构**策略，分阶段实施，每个阶段都保持系统可运行和测试通过，降低风险。
