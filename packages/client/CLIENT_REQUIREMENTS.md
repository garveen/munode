# MuNode 无头客户端 (Headless Client) 需求文档

**版本**: 1.0  
**创建日期**: 2025-11-20  
**目标**: 为 AI 辅助开发提供精简的功能需求描述

---

## 一、项目定位

### 1.1 核心目标
实现一个可编程的 Mumble 客户端，支持通过多种接口（HTTP API、WebSocket、Node.js API）控制和监听，用于机器人、自动化、集成等场景。

### 1.2 应用场景
- **语音机器人**: TTS 播报、自动应答
- **录音系统**: 会议录制、语音监控
- **跨平台桥接**: 连接不同语音平台
- **自动化测试**: 服务器功能测试
- **监控告警**: 服务器状态监控和通知

---

## 二、架构设计

### 2.1 包结构
```
packages/client/
├── src/
│   ├── core/                 # 核心客户端
│   │   ├── mumble-client.ts  # 主客户端类
│   │   ├── connection.ts     # TCP/UDP 连接管理
│   │   ├── crypto.ts         # 加密解密 (OCB2-AES128)
│   │   ├── auth.ts           # 认证流程
│   │   └── state.ts          # 客户端状态管理
│   │
│   ├── audio/                # 音频处理
│   │   ├── encoder.ts        # 音频编码器 (Opus)
│   │   ├── decoder.ts        # 音频解码器 (Opus/CELT)
│   │   ├── stream.ts         # 音频流管理
│   │   └── format.ts         # 音频格式转换
│   │
│   ├── api/                  # 外部接口
│   │   ├── http-server.ts    # HTTP REST API
│   │   ├── websocket.ts      # WebSocket 接口
│   │   └── node-api.ts       # Node.js 编程接口
│   │
│   ├── events/               # 事件系统
│   │   ├── event-emitter.ts  # 事件总线
│   │   └── webhook.ts        # Webhook 推送
│   │
│   └── types/                # 类型定义
│       ├── client-types.ts
│       ├── audio-types.ts
│       └── api-types.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

### 2.2 技术栈
- **基础**: TypeScript, Node.js
- **协议**: @munode/protocol (Protocol Buffers)
- **加密**: OCB2-AES128 (复用 edge-server 实现)
- **音频编码**: opus 库 (Opus)
- **音频格式**: FFmpeg 或 fluent-ffmpeg (格式转换)
- **HTTP 框架**: Fastify
- **WebSocket**: ws
- **日志**: @munode/common 的 logger

### 2.3 统一架构设计

#### 2.3.1 核心原则
三种API实现（HTTP REST API、WebSocket、Node.js API）使用统一的业务代码结构，通过单一入口进行分发，避免代码重复和维护困难。

#### 2.3.2 架构模式
```
[HTTP API] ──┐
             │
[WebSocket] ─┼─→ [API Dispatcher] ─→ [Business Logic Layer]
             │
[Node.js API]─┘
```

#### 2.3.3 组件职责
- **API Dispatcher**: 统一请求分发器，负责参数验证、权限检查、请求路由
- **Business Logic Layer**: 业务逻辑层，包含所有核心功能实现
- **Protocol Layer**: 协议层，处理 Mumble 协议编解码
- **Core Layer**: 核心层，管理连接、状态、音频处理

#### 2.3.4 实现方式
```typescript
// packages/client/src/api/dispatcher.ts
class ApiDispatcher {
  // 统一业务逻辑入口
  async dispatch(action: string, params: any, context: ApiContext): Promise<any> {
    // 参数验证
    const validatedParams = await this.validateParams(action, params);
    
    // 权限检查
    await this.checkPermissions(action, context);
    
    // 路由到具体业务处理器
    const handler = this.getHandler(action);
    return await handler.execute(validatedParams, context);
  }
}

// packages/client/src/business/handlers/
class ConnectHandler implements BusinessHandler {
  async execute(params: ConnectParams, context: ApiContext): Promise<void> {
    // 业务逻辑实现
    await context.client.connect(params);
  }
}
```

#### 2.3.5 优势
- **代码复用**: 三种API共享同一套业务逻辑
- **一致性**: 行为和错误处理完全一致
- **维护性**: 业务逻辑修改只需在一处进行
- **扩展性**: 新增API类型或功能时只需添加分发规则

### 2.4 代码复用策略

#### 2.4.1 跨包共用代码识别
Client 和 Edge Server 之间存在大量共用代码，特别是：
- **加密模块**: OCB2-AES128 加密实现
- **协议处理**: Mumble 消息编解码
- **音频处理**: 编解码器、格式转换
- **工具函数**: 权限检查、状态管理、配置加载
- **类型定义**: 共享的接口和枚举

#### 2.4.2 Common 包职责
所有共用代码应提取到 `@munode/common` 包中：
- **crypto/**: 加密解密相关 (OCB2-AES128 等)
- **audio/**: 音频编解码、格式转换
- **utils/**: 通用工具函数、配置管理

#### 2.4.3 Protocol 包职责
共享的类型定义和接口应统一放在 `@munode/protocol` 包中：
- **types/**: 共享类型定义和接口
- **Protocol Buffers 生成的类型**: Mumble.proto 生成的 TypeScript 类型
- **消息接口**: 所有 Mumble 协议消息的类型定义
- **枚举定义**: 权限标志、消息类型、错误代码等枚举
- **业务接口**: 客户端和服务器共享的业务逻辑接口
- **常量定义**: 协议相关的常量和配置值

**重要**: Client 和 Edge Server 之间共享的类型定义必须放在 protocol 包中，确保类型一致性和向后兼容性。

#### 2.4.4 实现原则
- **单一职责**: 每个模块只负责一个功能领域
- **依赖倒置**: 通过接口而非具体实现进行依赖
- **版本兼容**: 确保 API 向后兼容
- **测试覆盖**: 共用代码需要完整的单元测试

#### 2.4.5 迁移策略
1. 识别现有共用代码 (如 edge-server 的 ocb2-aes128.ts)
2. 提取到 common 包并保持向后兼容
3. 更新 client 和 edge-server 的依赖
4. 逐步重构调用方代码

---

## 三、核心功能需求

### 3.1 连接与认证

#### 3.1.1 连接建立
- 支持 TCP 和 UDP 连接
- TLS/SSL 证书验证和客户端证书
- 自动重连机制
- 连接超时处理
- DNS 解析和 SRV 记录支持

#### 3.1.2 认证流程
- 用户名密码认证
- 证书认证
- 访问令牌 (Access Tokens)
- 临时访问令牌 (Temporary Access Tokens)
- 认证失败重试策略

#### 3.1.3 加密
- OCB2-AES128 加密 (TCP 语音和 UDP 语音)
- 密钥交换和同步 (CryptSetup)
- 自动 nonce resync

### 3.2 频道操作

#### 3.2.1 基础操作
- 加入频道 (移动到频道)
- 创建频道 (临时或永久)
- 删除频道
- 重命名频道
- 修改频道描述
- 调整频道位置

#### 3.2.2 高级功能
- 频道链接 (Channel Links)
- 监听频道 (Listen Channel)
- 频道权限查询
- 频道树遍历

### 3.3 用户操作

#### 3.3.1 状态管理
- 设置自我静音 (Self Mute)
- 设置自我耳聋 (Self Deaf)
- 设置优先发言 (Priority Speaker)
- 设置录音状态 (Recording)
- 更新用户评论 (Comment)
- 更新用户头像 (Texture)

#### 3.3.2 用户查询
- 获取在线用户列表
- 查询注册用户
- 获取用户统计信息 (UserStats)
- 获取用户权限

#### 3.3.3 管理操作
- 踢出用户 (Kick)
- 封禁用户 (Ban)
- 解除封禁
- 强制静音/耳聋
- 移动用户到频道

### 3.4 权限系统

#### 3.4.1 ACL 管理
- 查询频道 ACL
- 修改频道 ACL
- 管理用户组 (Groups)
- ACL 继承控制

#### 3.4.2 权限查询
- 查询频道权限 (PermissionQuery)
- 检查特定权限位
- 权限拒绝事件处理

### 3.5 消息系统

#### 3.5.1 文本消息
- 发送私聊消息
- 发送频道消息
- 发送树消息 (Tree Message)
- HTML 消息支持
- 消息接收和解析

#### 3.5.2 右键菜单
- 注册上下文操作 (Context Actions)
- 响应上下文操作调用
- 动态添加/移除菜单项

### 3.6 插件系统

#### 3.6.1 插件数据
- 发送插件数据 (PluginDataTransmission)
- 接收插件数据
- 插件身份标识
- 插件上下文管理

#### 3.6.2 位置音频
- 设置位置音频上下文
- 设置位置音频身份

### 3.7 其他功能

#### 3.7.1 服务器信息
- 获取服务器版本
- 获取服务器配置
- 获取服务器欢迎信息
- Ping/Pong 心跳

#### 3.7.2 资源请求
- 请求 Blob 数据 (RequestBlob)
- 频道描述
- 用户头像
- 用户评论

#### 3.7.3 语音目标
- 设置耳语目标 (VoiceTarget)
- 多目标语音路由
- 频道树语音
- 组语音

---

## 四、音频处理需求

### 4.1 音频编码

#### 4.1.1 编码器支持
- **Opus**: 主要编码器，质量优先
- 支持可变比特率 (VBR)
- 支持恒定比特率 (CBR)
- 可配置比特率 (8-128 kbps)
- 可配置帧大小 (10ms, 20ms, 40ms, 60ms)

#### 4.1.2 编码参数
- 采样率: 48kHz (标准), 支持重采样
- 声道: 单声道 (Mono)
- 位深: 16-bit PCM

**重要**: 客户端和服务器之间只使用 Opus 编码，不支持 CELT 或其他编码格式。

### 4.2 音频解码

#### 4.2.1 解码器支持
- **Opus**: 主要解码器
- **无解码 (Passthrough)**: 直接转发编码数据
- **自动检测**: 根据包头自动选择解码器

#### 4.2.2 解码输出
- PCM 16-bit 单声道
- 可配置输出采样率
- 自动重采样到目标格式

**重要**: 客户端和服务器之间只使用 Opus 编码，不支持 CELT 或其他编码格式。

### 4.3 音频流管理

#### 4.3.1 输入流
- **Node.js Stream**: 支持 Readable Stream 输入
- **Buffer**: 支持直接提供 Buffer
- **文件**: 支持音频文件路径 (通过 FFmpeg 解码)
- **HTTP URL**: 支持 HTTP/HTTPS 音频流
- **静音检测**: VAD (Voice Activity Detection)

#### 4.3.2 输出流
- **Node.js Stream**: 输出为 Writable Stream
- **Buffer**: 输出为 Buffer 数组
- **文件**: 保存为音频文件
- **实时播放**: 混音后输出

#### 4.3.3 音频混音
- 多用户音频混音
- 音量控制
- 静音/耳聋用户过滤
- 监听频道混音

### 4.4 格式转换

#### 4.4.1 输入格式支持
- WAV, MP3, OGG, FLAC, AAC
- 自动格式检测
- FFmpeg 集成

#### 4.4.2 输出格式支持
- PCM (原始)
- WAV
- OGG/Opus
- 自定义格式 (通过 FFmpeg)

### 4.5 音频处理流程

#### 4.5.1 发送流程
```
[输入源] → [格式转换] → [重采样] → [Opus编码] → [加密] → [UDP/TCP发送]
```

#### 4.5.2 接收流程
```
[UDP/TCP接收] → [解密] → [解码器选择] → [解码] → [混音] → [输出流]
```

#### 4.5.3 特殊模式
- **原样发送 (Passthrough)**: 跳过编码步骤，直接发送预编码数据
- **自动检测 (Auto-detect)**: 根据包头和序列号自动检测编码格式

---

## 五、外部接口设计

### 5.1 HTTP REST API

#### 5.1.1 连接管理
- `POST /client/connect` - 连接到服务器
- `POST /client/disconnect` - 断开连接
- `GET /client/status` - 获取连接状态

#### 5.1.2 频道操作
- `POST /channel/join` - 加入频道
- `POST /channel/create` - 创建频道
- `DELETE /channel/:id` - 删除频道
- `PUT /channel/:id` - 更新频道信息
- `GET /channel/list` - 获取频道树

#### 5.1.3 用户操作
- `GET /user/list` - 获取用户列表
- `POST /user/kick` - 踢出用户
- `POST /user/ban` - 封禁用户
- `PUT /user/state` - 更新自身状态

#### 5.1.4 消息操作
- `POST /message/send` - 发送文本消息
- `GET /message/history` - 获取消息历史

#### 5.1.5 音频操作
- `POST /audio/send` - 发送音频 (Multipart 上传)
- `POST /audio/speak` - TTS 文字转语音
- `POST /audio/stream/start` - 开始音频流
- `POST /audio/stream/stop` - 停止音频流

#### 5.1.6 配置
- `GET /config` - 获取客户端配置
- `PUT /config` - 更新客户端配置

### 5.2 WebSocket 接口

#### 5.2.1 连接
- URL: `ws://host:port/ws`
- 认证: Token 或 Query Parameter

#### 5.2.2 消息格式
```json
{
  "type": "command|event",
  "id": "unique-request-id",
  "action": "action-name",
  "data": { /* payload */ }
}
```

#### 5.2.3 命令 (Client → Server)
- `connect` - 连接到 Mumble 服务器
- `disconnect` - 断开连接
- `joinChannel` - 加入频道
- `sendMessage` - 发送消息
- `sendAudio` - 发送音频数据 (Base64)
- `updateState` - 更新状态

#### 5.2.4 事件 (Server → Client)
- `connected` - 已连接
- `disconnected` - 已断开
- `userJoined` - 用户加入
- `userLeft` - 用户离开
- `channelCreated` - 频道创建
- `messageReceived` - 收到消息
- `audioReceived` - 收到音频 (Base64)
- `stateChanged` - 状态变更

#### 5.2.5 音频流
- **实时音频**: 通过 WebSocket 传输音频帧
- **双向通信**: 支持同时发送和接收音频
- **格式**: Base64 编码的 Opus 包或 PCM 数据

### 5.3 Node.js API

#### 5.3.1 基础接口
```typescript
class MumbleClient extends EventEmitter {
  // 连接管理
  connect(options: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // 频道操作
  joinChannel(channelId: number): Promise<void>;
  createChannel(name: string, parent?: number): Promise<number>;
  deleteChannel(channelId: number): Promise<void>;
  
  // 用户操作
  getUsers(): User[];
  getUser(session: number): User | null;
  kickUser(session: number, reason?: string): Promise<void>;
  banUser(session: number, reason?: string): Promise<void>;
  
  // 状态管理
  setSelfMute(mute: boolean): Promise<void>;
  setSelfDeaf(deaf: boolean): Promise<void>;
  setRecording(recording: boolean): Promise<void>;
  
  // 消息
  sendMessage(target: MessageTarget, message: string): Promise<void>;
  
  // 音频
  sendAudio(audio: AudioInput): Promise<void>;
  startAudioStream(stream: Readable): Promise<AudioStream>;
  stopAudioStream(): Promise<void>;
  
  // 事件监听
  on(event: string, listener: Function): this;
}
```

#### 5.3.2 事件列表
```typescript
// 连接事件
'connected' - 已连接
'disconnected' - 已断开
'error' - 错误

// 用户事件
'userJoined' - 用户加入
'userLeft' - 用户离开
'userMoved' - 用户移动频道
'userStateChanged' - 用户状态变更

// 频道事件
'channelCreated' - 频道创建
'channelRemoved' - 频道删除
'channelUpdated' - 频道更新

// 消息事件
'message' - 收到文本消息
'permissionDenied' - 权限被拒绝

// 音频事件
'audioReceived' - 收到音频数据
'audioStreamStarted' - 音频流开始
'audioStreamEnded' - 音频流结束

// 服务器事件
'serverSync' - 服务器同步完成
'serverConfig' - 服务器配置
```

#### 5.3.3 类型定义
```typescript
interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  tokens?: string[];
  rejectUnauthorized?: boolean;
  clientCert?: Buffer;
  clientKey?: Buffer;
}

interface AudioInput {
  data: Buffer | Readable | string; // Buffer, Stream, or file path
  format?: 'raw' | 'opus' | 'auto';
  codec?: 'opus' | 'passthrough' | 'auto-detect';
  encoder?: EncoderOptions;
}

interface EncoderOptions {
  bitrate?: number;
  frameSize?: number;
  vbr?: boolean;
}

interface AudioOutput {
  session: number;
  sequence: number;
  data: Buffer;
  codec: 'opus' | 'celt';
  pcm?: Buffer; // 解码后的 PCM (可选)
}
```

### 5.4 Webhook 推送

#### 5.4.1 配置
```typescript
interface WebhookConfig {
  url: string;
  events: string[]; // 订阅的事件
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  retry?: number;
}
```

#### 5.4.2 推送格式
```json
{
  "event": "userJoined",
  "timestamp": 1700000000000,
  "data": {
    "session": 123,
    "name": "User Name",
    "channel_id": 1
  }
}
```

#### 5.4.3 支持的事件
- 所有 Node.js API 的事件
- 可配置事件过滤
- 批量推送支持 (可选)

---

## 六、配置管理

### 6.1 客户端配置
```typescript
interface ClientConfig {
  // 连接配置
  connection: {
    host: string;
    port: number;
    autoReconnect: boolean;
    reconnectDelay: number;
    reconnectMaxDelay: number;
    connectTimeout: number;
  };
  
  // 认证配置
  auth: {
    username: string;
    password?: string;
    tokens?: string[];
    certificate?: string; // 文件路径或 PEM 字符串
    key?: string;
  };
  
  // 音频配置
  audio: {
    encoder: {
      codec: 'opus';
      bitrate: number;
      frameSize: number;
      vbr: boolean;
    };
    decoder: {
      codecs: ['opus', 'celt'];
      autoDetect: boolean;
    };
    inputSampleRate: number;
    outputSampleRate: number;
  };
  
  // API 配置
  api: {
    http: {
      enabled: boolean;
      host: string;
      port: number;
      cors: boolean;
    };
    websocket: {
      enabled: boolean;
      path: string;
    };
  };
  
  // Webhook 配置
  webhooks: WebhookConfig[];
  
  // 日志配置
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
  };
}
```

### 6.2 配置文件
- 默认路径: `config/client.json`
- 支持环境变量覆盖
- 支持命令行参数覆盖

---

## 七、状态管理

### 7.1 客户端状态

#### 7.1.1 连接状态
```typescript
enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Authenticating = 'authenticating',
  Ready = 'ready',
  Disconnecting = 'disconnecting',
}
```

#### 7.1.2 会话状态
```typescript
interface SessionState {
  session: number;
  channel_id: number;
  self_mute: boolean;
  self_deaf: boolean;
  suppress: boolean;
  recording: boolean;
  priority_speaker: boolean;
  listeningChannels: number[];
}
```

### 7.2 服务器状态

#### 7.2.1 服务器信息
```typescript
interface ServerInfo {
  version: number;
  release: string;
  os: string;
  maxBandwidth: number;
  maxUsers: number;
  welcomeText: string;
  allowHtml: boolean;
  messageLength: number;
}
```

#### 7.2.2 频道树
```typescript
interface Channel {
  channel_id: number;
  parent: number;
  name: string;
  description?: string;
  temporary: boolean;
  position: number;
  links: number[];
  max_users: number;
  children: number[];
}
```

#### 7.2.3 用户列表
```typescript
interface User {
  session: number;
  user_id?: number;
  name: string;
  channel_id: number;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  recording: boolean;
  priority_speaker: boolean;
  hash?: string;
  comment?: string;
  texture?: Buffer;
}
```

---

## 八、错误处理

### 8.1 错误类型
```typescript
class MumbleClientError extends Error {
  code: string;
  details?: any;
}

// 错误代码
enum ErrorCode {
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  AUTH_FAILED = 'AUTH_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  INVALID_AUDIO = 'INVALID_AUDIO',
  CRYPTO_ERROR = 'CRYPTO_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
}
```

### 8.2 错误处理策略
- 连接错误: 自动重连 (可配置)
- 认证错误: 抛出错误，不重连
- 权限错误: 触发事件，记录日志
- 音频错误: 记录日志，跳过当前包
- 网络错误: 自动重连或降级到 TCP

---

## 九、性能要求

### 9.1 延迟
- 音频端到端延迟: < 100ms
- API 响应时间: < 50ms
- WebSocket 消息延迟: < 10ms

### 9.2 吞吐量
- 支持同时发送和接收音频
- 支持多路音频流混音
- HTTP API 支持 1000 req/s
- WebSocket 支持 100 并发连接

### 9.3 资源占用
- 内存: < 100MB (空闲)
- CPU: < 5% (空闲), < 20% (活跃语音)
- 网络: 音频 ~40 kbps per stream

---

## 十、安全要求

### 10.1 认证安全
- 支持客户端证书认证
- 密码不存储在日志中
- Token 安全存储

### 10.2 传输安全
- 强制 TLS 连接 (可选)
- 证书验证
- 加密语音数据

### 10.3 API 安全
- HTTP API 认证 (Bearer Token)
- WebSocket 认证
- CORS 配置
- 请求限流

---

## 十一、测试要求

### 11.1 单元测试
- 核心功能测试覆盖率 > 80%
- 音频编解码测试
- 加密解密测试
- 状态管理测试

### 11.2 集成测试
- 与真实 Mumble 服务器连接测试
- 与 MuNode Hub/Edge 连接测试
- 多客户端并发测试

### 11.3 性能测试
- 音频延迟测试
- 高并发连接测试
- 长时间运行稳定性测试

---

## 十二、文档要求

### 12.1 API 文档
- HTTP API 文档 (OpenAPI/Swagger)
- WebSocket 协议文档
- Node.js API 文档 (TypeDoc)

### 12.2 使用指南
- 快速开始指南
- 配置说明
- 示例代码
- 故障排查

### 12.3 开发者文档
- 架构设计文档
- 音频处理流程
- 状态机设计
- 扩展指南

---

## 十三、交付物

### 13.1 代码
- TypeScript 源代码
- 编译后的 JavaScript
- 类型定义文件 (.d.ts)

### 13.2 配置
- 默认配置文件
- 配置示例
- 环境变量说明

### 13.3 文档
- README.md
- API 文档
- 使用指南

### 13.4 工具
- CLI 工具 (可选)
- 配置生成工具
- 测试工具

---

## 十四、依赖项

### 14.1 内部依赖
- @munode/common
- @munode/protocol

### 14.2 外部依赖
- opus (音频编码/解码)
- fastify (HTTP 服务器)
- ws (WebSocket)
- fluent-ffmpeg (音频格式转换)
- long (大整数支持)

---

## 十五、实现优先级

### P0 - 核心功能 (第1周)
1. 连接与认证
2. 基础频道操作
3. 用户状态管理
4. Opus 音频编码
5. Opus 音频解码
6. Node.js API

### P1 - 基础接口 (第2周)
1. HTTP REST API
2. WebSocket 接口
3. 事件系统
4. 文本消息
5. 音频流管理

### P2 - 高级功能 (第3周)
1. 监听频道
2. 语音目标
3. 插件数据传输
4. 右键菜单
5. Webhook 推送

### P3 - 增强功能 (第4周)
1. 音频格式转换
2. 音频混音
3. ACL 管理
4. 完整的权限系统
5. 性能优化
6. 完整测试

---

## 十六、成功标准

### 16.1 功能完整性
- 实现所有 P0-P1 功能
- 通过与 MuNode 服务器的集成测试
- 通过与官方 Mumble 服务器的兼容性测试

### 16.2 性能指标
- 音频延迟 < 100ms
- API 响应时间 < 50ms
- 稳定运行 > 24 小时

### 16.3 代码质量
- 单元测试覆盖率 > 80%
- 无严重 Bug
- 代码符合项目规范

### 16.4 文档完整性
- API 文档完整
- 使用指南清晰
- 示例代码可运行

---

## 附录

### A. 术语表
- **Mumble**: 开源低延迟语音聊天软件
- **Opus**: 高质量音频编解码器
- **CELT**: 低延迟音频编解码器 (已被 Opus 取代)
- **OCB2-AES128**: 认证加密模式
- **VAD**: 语音活动检测 (Voice Activity Detection)
- **ACL**: 访问控制列表 (Access Control List)

### B. 参考资料
- Mumble Protocol Documentation
- Opus Codec Documentation
- MuNode 项目文档
- Protocol Buffers 定义 (Mumble.proto)

---

**文档维护**: GitHub Copilot  
**最后更新**: 2025-11-20
