# Protobuf 库迁移：从 google-protobuf 到 ts-proto

## 1. 概述

本文档详细说明将 MuNode 项目从 `google-protobuf` 迁移到 `ts-proto` 所需的所有代码改动。

### 1.1 迁移原因

- **更好的 TypeScript 集成**：ts-proto 生成纯 TypeScript 类型，更符合现代 TypeScript 开发习惯
- **更简洁的 API**：使用纯对象而不是类实例，更易于序列化和调试
- **更好的性能**：底层使用 `@bufbuild/protobuf`，性能更优
- **类型安全**：更严格的类型检查，减少运行时错误
- **更小的包体积**：生成的代码更简洁

### 1.2 两个库的核心差异对比

| 特性 | google-protobuf (protoc-gen-ts) | ts-proto |
|------|--------------------------------|----------|
| 消息类型 | 继承自 `pb_1.Message` 的类 | 纯 TypeScript interface |
| 字段访问 | getter/setter 方法 | 直接属性访问 |
| 构造函数 | `new Message({...})` | 对象字面量 `{...}` |
| 序列化 | `message.serialize()` | `Message.encode(message).finish()` |
| 反序列化 | `Message.deserialize(bytes)` | `Message.decode(bytes)` |
| JSON 转换 | `message.toObject()` / `Message.fromObject()` | `Message.toJSON()` / `Message.fromJSON()` |
| Optional 字段检测 | `message.has_field_name` 属性 | 使用 `field !== undefined` |
| Repeated 字段 | getter 返回数组 | 直接是数组 |
| 工厂方法 | 无 | `Message.create()`, `Message.fromPartial()` |
| 运行时依赖 | `google-protobuf` | `@bufbuild/protobuf` (仅在 encode/decode 时) |

## 2. 当前项目使用情况分析

### 2.1 生成的代码结构

#### google-protobuf 生成的代码

```typescript
export namespace mumbleproto {
  export class Version extends pb_1.Message {
    #one_of_decls: number[][] = [];
    
    constructor(data?: any[] | {
      version?: number;
      release?: string;
      os?: string;
      os_version?: string;
    }) {
      super();
      pb_1.Message.initialize(this, Array.isArray(data) ? data : [], 0, -1, [], this.#one_of_decls);
      if (!Array.isArray(data) && typeof data == "object") {
        if ("version" in data && data.version != undefined) {
          this.version = data.version;
        }
        // ...
      }
    }
    
    // Getter/Setter
    get version() {
      return pb_1.Message.getFieldWithDefault(this, 1, 0) as number;
    }
    set version(value: number) {
      pb_1.Message.setField(this, 1, value);
    }
    
    // Optional 字段检测
    get has_version() {
      return pb_1.Message.getField(this, 1) != null;
    }
    
    // 序列化
    serialize(): Uint8Array;
    serialize(w: pb_1.BinaryWriter): void;
    serialize(w?: pb_1.BinaryWriter): Uint8Array | void {
      const writer = w || new pb_1.BinaryWriter();
      if (this.has_version)
        writer.writeUint32(1, this.version);
      // ...
      if (!w)
        return writer.getResultBuffer();
    }
    
    // 反序列化
    static deserialize(bytes: Uint8Array | pb_1.BinaryReader): Version {
      const reader = bytes instanceof pb_1.BinaryReader ? bytes : new pb_1.BinaryReader(bytes);
      const message = new Version();
      while (reader.nextField()) {
        if (reader.isEndGroup())
          break;
        switch (reader.getFieldNumber()) {
          case 1:
            message.version = reader.readUint32();
            break;
          // ...
          default: reader.skipField();
        }
      }
      return message;
    }
    
    // JSON 转换
    static fromObject(data: {...}): Version {
      const message = new Version({});
      if (data.version != null) {
        message.version = data.version;
      }
      // ...
      return message;
    }
    
    toObject() {
      const data: {...} = {};
      if (this.version != null) {
        data.version = this.version;
      }
      // ...
      return data;
    }
  }
}
```

#### ts-proto 生成的代码

```typescript
export interface Version {
  version: number;
  release: string;
  os: string;
  os_version: string;  // 使用 snakeToCamel=false 保持 snake_case
}

export const Version = {
  // 工厂方法
  create(base?: DeepPartial<Version>): Version {
    return {
      version: base?.version ?? 0,
      release: base?.release ?? "",
      os: base?.os ?? "",
      os_version: base?.os_version ?? "",  // 保持 snake_case
    };
  },
  
  // 从部分对象创建
  fromPartial(object: DeepPartial<Version>): Version {
    const message = { ...object } as Version;
    message.version ??= 0;
    message.release ??= "";
    message.os ??= "";
    message.os_version ??= "";  // 保持 snake_case
    return message;
  },
  
  // 序列化
  encode(message: Version, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.version !== 0) {
      writer.uint32(8).uint32(message.version);
    }
    if (message.release !== "") {
      writer.uint32(18).string(message.release);
    }
    // ...
    return writer;
  },
  
  // 反序列化
  decode(input: _m0.Reader | Uint8Array, length?: number): Version {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseVersion();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          message.version = reader.uint32();
          break;
        // ...
        default:
          reader.skipType(tag & 7);
          break;
      }
    }
    return message;
  },
  
  // JSON 转换
  fromJSON(object: any): Version {
    return {
      version: isSet(object.version) ? Number(object.version) : 0,
      release: isSet(object.release) ? String(object.release) : "",
      os: isSet(object.os) ? String(object.os) : "",
      os_version: isSet(object.os_version) ? String(object.os_version) : "",  // 保持 snake_case
    };
  },
  
  toJSON(message: Version): unknown {
    const obj: any = {};
    message.version !== undefined && (obj.version = Math.round(message.version));
    message.release !== undefined && (obj.release = message.release);
    message.os !== undefined && (obj.os = message.os);
    message.os_version !== undefined && (obj.os_version = message.os_version);  // 保持 snake_case
    return obj;
  },
};

// 辅助函数
function createBaseVersion(): Version {
  return { version: 0, release: "", os: "", os_version: "" };  // 保持 snake_case
}
```

### 2.2 项目中的使用模式

#### 模式 1: 反序列化消息

```typescript
// 当前 (google-protobuf)
const userState = mumbleproto.UserState.deserialize(data);

// 迁移后 (ts-proto)
const userState = mumbleproto.UserState.decode(data);
```

#### 模式 2: 创建并序列化消息

```typescript
// 当前 (google-protobuf)
const reject = new mumbleproto.Reject({
  type: mumbleproto.Reject.RejectType.InvalidUsername,
  reason: 'Invalid username'
}).serialize();

// 迁移后 (ts-proto)
const reject = mumbleproto.Reject.encode({
  type: mumbleproto.Reject.RejectType.InvalidUsername,
  reason: 'Invalid username'
}).finish();
```

#### 模式 3: 使用 fromObject 创建消息

```typescript
// 当前 (google-protobuf)
const userStateMessage = mumbleproto.UserState.fromObject({
  channel_id: channelId,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: []
});
const serialized = userStateMessage.serialize();

// 迁移后 (ts-proto with snakeToCamel=false)
const serialized = mumbleproto.UserState.encode({
  channel_id: channelId,  // 字段名保持 snake_case
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: []
}).finish();
```

#### 模式 4: 检查 optional 字段

```typescript
// 当前 (google-protobuf)
if (userState.has_channel_id) {
  // 字段已设置
}

// 迁移后 (ts-proto)
if (userState.channelId !== undefined) {
  // 字段已设置
}
```

#### 模式 5: 使用 toObject 转换

```typescript
// 当前 (google-protobuf)
const obj = channelState.toObject();

// 迁移后 (ts-proto)
const obj = mumbleproto.ChannelState.toJSON(channelState);
// 或者直接使用对象（因为本身就是普通对象）
const obj = channelState;
```

#### 模式 6: TypedRPC 参数转换

```typescript
// 当前 (google-protobuf)
request.edge_register = hubedgeRpc.EdgeRegisterParams.fromObject({
  server_id: p.server_id,
  name: p.name,
  // ...
});

// 提取参数
return request.edge_register?.toObject() as RPCParams<'edge.register'>;

// 迁移后 (ts-proto)
request.edge_register = {
  serverId: p.server_id,  // 注意字段名变化
  name: p.name,
  // ...
};

// 提取参数（直接使用，无需 toObject）
return request.edge_register as RPCParams<'edge.register'>;
```

## 3. 详细迁移步骤

### 3.1 修改 package.json 依赖

**文件**: `packages/protocol/package.json`

```diff
  "dependencies": {
    "@bufbuild/protobuf": "^2.10.1",
    "@munode/common": "workspace:*",
-   "google-protobuf": "3.21.4",
-   "protoc": "^33.1.0",
    "ws": "^8.18.3"
  },
  "devDependencies": {
-   "@types/google-protobuf": "^3.15.12",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.18.1",
-   "protoc-gen-ts": "^0.8.7",
+   "ts-proto": "^2.8.3",
    "typescript": "^5.9.3"
  }
```

### 3.2 修改 protobuf 生成命令

**文件**: `packages/protocol/package.json`

```diff
  "scripts": {
    "build": "node esbuild.config.mjs && tsc --emitDeclarationOnly --outDir dist",
    "dev": "node esbuild.config.mjs --watch",
    "clean": "rm -rf dist *.tsbuildinfo src/generated/proto",
-   "generate:proto": "protoc --proto_path=./proto --ts_out=service=grpc-node:./src/generated/proto ./proto/Mumble.proto ./proto/HubEdgeSync.proto ./proto/HubEdgeRPC.proto ./proto/HubEdge.proto",
+   "generate:proto": "protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto --ts_proto_out=./src/generated/proto --ts_proto_opt=outputServices=generic-definitions,outputClientImpl=false,esModuleInterop=true,env=node,useOptionals=messages,oneof=unions-value,snakeToCamel=false,forceLong=number,useExactTypes=true,outputPartialMethods=true --proto_path=./proto ./proto/Mumble.proto ./proto/HubEdgeSync.proto ./proto/HubEdgeRPC.proto ./proto/HubEdge.proto",
    "test": "vitest run"
  },
```

**ts_proto_opt 参数配置说明**（仅列出非默认值）：

| 参数 | 值 | 说明 | 原因 |
|------|-----|------|------|
| `outputServices` | `generic-definitions` | 生成通用服务定义 | 项目自定义 RPC 实现，不需要特定框架绑定 |
| `outputClientImpl` | `false` | 不生成客户端实现 | 项目使用自定义 TypedRPC，不需要 Twirp 客户端 |
| `esModuleInterop` | `true` | ESModule 兼容模式 | 项目使用 ESM 模块系统 |
| `env` | `node` | Node.js 环境 | `bytes` 类型使用 `Buffer` 更符合 Node.js 生态 |
| `useOptionals` | `messages` | 消息字段为可选 | 减少必填字段，更灵活（proto2 本身就是 optional） |
| `oneof` | `unions-value` | oneof 生成 ADT 联合 | 类型安全的 oneof 处理，避免运行时错误 |
| `snakeToCamel` | `false` | **保持 snake_case** | **关键！无需修改现有代码字段名** |
| `forceLong` | `number` | 64位数字用 number | 项目无大整数需求，默认值但明确声明 |
| `useExactTypes` | `true` | 精确类型检查 | 防止对象字面量中的多余属性 |
| `outputPartialMethods` | `true` | 生成 fromPartial 方法 | 便于部分更新消息，提高开发效率 |

**默认值参数（无需配置）**：
- `useOptionals=none` → 改为 `messages`（消息字段可选更灵活）
- `oneof=properties` → 改为 `unions-value`（类型安全）
- `outputEncodeMethods=true` - 需要 encode/decode 方法
- `outputJsonMethods=true` - 需要 toJSON/fromJSON 方法
- `outputClientImpl=true` → 改为 `false`（项目自定义 TypedRPC，不需要生成客户端）
- `stringEnums=false` - 使用数字枚举（符合 protobuf 规范）
- `useDate=true` - Timestamp 映射为 Date 对象
- `useMapType=false` - 使用 `{[key: type]: value}` 而非 Map
- `useReadonlyTypes=false` - 字段可变，符合项目需求

### 3.3 修改 esbuild 配置

**文件**: `packages/protocol/esbuild.config.mjs`

```diff
  external: [
    '@munode/common',
    '@bufbuild/protobuf',
-   'google-protobuf',
    'msgpackr',
-   'protoc',
    'ws'
  ],
```

### 3.4 代码迁移规则

#### 规则 1: 消息反序列化

**影响文件**：
- `packages/edge-server/src/handlers/state-handlers.ts`
- `packages/edge-server/src/auth/auth-handler.ts`
- `packages/edge-server/src/message-handler.ts`
- `packages/hub-server/src/relay/client-message-router.ts`

```typescript
// 替换模式
- mumbleproto.MessageType.deserialize(data)
+ mumbleproto.MessageType.decode(data)
```

**示例**：
```typescript
// Before
const userState = mumbleproto.UserState.deserialize(data);
const channelState = mumbleproto.ChannelState.deserialize(data);
const authMessage = mumbleproto.Authenticate.deserialize(data);

// After
const userState = mumbleproto.UserState.decode(data);
const channelState = mumbleproto.ChannelState.decode(data);
const authMessage = mumbleproto.Authenticate.decode(data);
```

#### 规则 2: 消息创建和序列化

**影响文件**：
- `packages/edge-server/src/auth/auth-handler.ts`
- `packages/edge-server/src/managers/event-setup-manager.ts`
- `packages/client/src/core/mumble-client.ts`

```typescript
// 替换模式 1: new + serialize
- new mumbleproto.MessageType({...}).serialize()
+ mumbleproto.MessageType.encode({...}).finish()

// 替换模式 2: fromObject + serialize
- mumbleproto.MessageType.fromObject({...}).serialize()
+ mumbleproto.MessageType.encode({...}).finish()

// 替换模式 3: 先创建后序列化
- const message = new mumbleproto.MessageType({...});
- const serialized = message.serialize();
+ const serialized = mumbleproto.MessageType.encode({...}).finish();
```

**示例**：
```typescript
// Before
const reject = new mumbleproto.Reject({
  type: mumbleproto.Reject.RejectType.InvalidUsername,
  reason: 'Invalid username'
}).serialize();

// After
const reject = mumbleproto.Reject.encode({
  type: mumbleproto.Reject.RejectType.InvalidUsername,
  reason: 'Invalid username'
}).finish();

// Before
const userStateMessage = mumbleproto.UserState.fromObject({
  channel_id: channelId,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: []
});
const serialized = userStateMessage.serialize();

// After (with snakeToCamel=false)
const serialized = mumbleproto.UserState.encode({
  channel_id: channelId,  // 字段名保持 snake_case
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: []
}).finish();
```

#### 规则 3: Optional 字段检测

**影响文件**：
- `packages/edge-server/src/handlers/state-handlers.ts`
- `packages/client/src/core/mumble-client.ts`
- `packages/hub-server/src/relay/client-message-router.ts`

```typescript
// 替换模式
- if (message.has_field_name)
+ if (message.fieldName !== undefined)

// 对于 protobuf optional 字段，需要明确检查 undefined
- if (message.has_field_name && message.field_name === someValue)
+ if (message.fieldName !== undefined && message.fieldName === someValue)
```

**示例**：
```typescript
// Before
if (userState.has_channel_id) {
  const channelId = userState.channel_id;
}

if (channelState.has_name && channelState.name === name &&
    channelState.has_parent && channelState.parent === parentId) {
  // ...
}

// After (with snakeToCamel=false)
if (userState.channel_id !== undefined) {
  const channelId = userState.channel_id;
}

if (channelState.name !== undefined && channelState.name === name &&
    channelState.parent !== undefined && channelState.parent === parentId) {
  // ...
}
```

#### 规则 4: toObject / fromObject 转换

**影响文件**：
- `packages/protocol/src/rpc/typed-rpc-server.ts`
- `packages/edge-server/src/handlers/state-handlers.ts`

```typescript
// 替换模式 1: toObject (用于 JSON 序列化)
- const obj = message.toObject()
+ const obj = MessageType.toJSON(message)

// 替换模式 2: fromObject (用于从 JSON 创建)
- const message = MessageType.fromObject(data)
+ const message = MessageType.fromJSON(data)

// 替换模式 3: 直接使用对象（ts-proto 消息本身就是普通对象）
- const obj = message.toObject()
+ const obj = message  // 直接使用即可
```

**示例**：
```typescript
// Before
return request.edge_register?.toObject() as RPCParams<'edge.register'>;
channelState: channelState.toObject(),

// After (选项 1: 使用 toJSON)
return request.edge_register ? MessageType.toJSON(request.edge_register) : undefined;

// After (选项 2: 直接使用，因为已经是普通对象)
return request.edge_register as RPCParams<'edge.register'>;
channelState: channelState,
```

#### 规则 5: 字段命名转换 (snake_case -> camelCase)

**⚠️ 重要配置说明**：

本项目**使用 `snakeToCamel=false` 选项保持 snake_case 字段名**，这样可以：
1. **无需修改字段名**：现有代码中的 `channel_id`、`user_id` 等字段名保持不变
2. **减少迁移工作量**：避免大量字段名替换
3. **保持一致性**：与 protobuf 定义完全一致

```typescript
// 使用 snakeToCamel=false 后，字段名保持 snake_case
export interface UserState {
  session?: number;
  actor?: number;
  name?: string;
  user_id?: number;
  channel_id?: number;
  self_mute?: boolean;
  self_deaf?: boolean;
  // ... 所有字段名与 .proto 文件保持一致
}
```

**如果不使用 `snakeToCamel=false`（默认行为）**：

ts-proto 默认会将 protobuf 的 `snake_case` 字段名转换为 TypeScript 的 `camelCase`，那么就需要修改所有字段访问：

| Protobuf (snake_case) | TypeScript (camelCase) |
|----------------------|------------------------|
| `server_id` | `serverId` |
| `session_id` | `sessionId` |
| `channel_id` | `channelId` |
| `user_id` | `userId` |
| `edge_id` | `edgeId` |
| `hub_server_id` | `hubServerId` |
| `edge_list` | `edgeList` |
| `user_count` | `userCount` |
| `channel_count` | `channelCount` |
| `cpu_usage` | `cpuUsage` |
| `memory_usage_mb` | `memoryUsageMb` |
| `bandwidth_in` | `bandwidthIn` |
| `bandwidth_out` | `bandwidthOut` |
| `temporary_access_tokens` | `temporaryAccessTokens` |
| `listening_channel_add` | `listeningChannelAdd` |
| `listening_channel_remove` | `listeningChannelRemove` |
| `os_version` | `osVersion` |
| `self_mute` | `selfMute` |
| `self_deaf` | `selfDeaf` |
| `priority_speaker` | `prioritySpeaker` |
| `plugin_context` | `pluginContext` |
| `plugin_identity` | `pluginIdentity` |
| `context_action` | `contextAction` |

**推荐做法**：使用 `snakeToCamel=false`，保持 snake_case，无需字段名转换！

#### 规则 6: TypedRPC 参数构造

**影响文件**：
- `packages/protocol/src/rpc/typed-rpc-client.ts`
- `packages/protocol/src/rpc/typed-rpc-server.ts`

```typescript
// Before (google-protobuf)
request.edge_register = hubedgeRpc.EdgeRegisterParams.fromObject({
  server_id: p.server_id,
  name: p.name,
  host: p.host,
  port: p.port,
  region: p.region,
  capacity: p.capacity,
  certificate: p.certificate,
  challenge: p.challenge,
  challenge_response: p.challenge_response,
});

// After (ts-proto with snakeToCamel=false)
request.edge_register = {
  server_id: p.server_id,
  name: p.name,
  host: p.host,
  port: p.port,
  region: p.region,
  capacity: p.capacity,
  certificate: p.certificate,
  challenge: p.challenge,
  challenge_response: p.challenge_response,
};
```

#### 规则 7: 嵌套消息访问

```typescript
// Before (google-protobuf)
const user = userList.User.deserialize(bytes);

// After (ts-proto)
const user = mumbleproto.UserList_User.decode(bytes);
// 或者
import { UserList_User } from './Mumble';
const user = UserList_User.decode(bytes);
```

### 3.5 类型定义更新

**影响文件**：
- `packages/protocol/src/rpc/rpc-types.ts`
- 任何直接引用 protobuf 消息类型的文件

```typescript
// Before (google-protobuf 生成的类)
import { mumbleproto } from '../generated/proto/Mumble.js';
type UserState = mumbleproto.UserState;  // 这是一个类

// After (ts-proto 生成的接口)
import { UserState } from '../generated/proto/Mumble.js';
// UserState 现在是一个纯接口
```

### 3.6 特殊情况处理

#### 情况 1: 消息复制

```typescript
// Before (google-protobuf)
const copy = new mumbleproto.UserState(original.toObject());

// After (ts-proto)
const copy = { ...original };  // 浅拷贝
// 或深拷贝
import { cloneDeep } from 'lodash';
const copy = cloneDeep(original);
```

#### 情况 2: 消息合并

```typescript
// Before (可能需要手动合并)
const merged = new mumbleproto.UserState();
Object.assign(merged, base, updates);

// After (ts-proto 提供 fromPartial)
const merged = mumbleproto.UserState.fromPartial({
  ...base,
  ...updates,
});
```

#### 情况 3: Repeated 字段操作

```typescript
// Before (google-protobuf)
message.addField(value);  // 某些生成器提供此方法
message.setFieldList([...]);

// After (ts-proto)
message.field = [...message.field, value];  // 直接操作数组
message.field = [...];
```

## 4. 受影响的文件清单

基于代码搜索结果，以下文件需要修改：

### 4.1 Protocol Package

- `packages/protocol/package.json` - 依赖更新
- `packages/protocol/esbuild.config.mjs` - 外部依赖配置
- `packages/protocol/src/rpc/typed-rpc-client.ts` - RPC 客户端
- `packages/protocol/src/rpc/typed-rpc-server.ts` - RPC 服务器

### 4.2 Edge Server

- `packages/edge-server/src/handlers/state-handlers.ts` - 状态处理器
- `packages/edge-server/src/message-handler.ts` - 消息处理器
- `packages/edge-server/src/auth/auth-handler.ts` - 认证处理器
- `packages/edge-server/src/managers/event-setup-manager.ts` - 事件管理器

### 4.3 Hub Server

- `packages/hub-server/src/relay/client-message-router.ts` - 消息路由

### 4.4 Client

- `packages/client/src/core/mumble-client.ts` - 客户端核心

### 4.5 生成的文件（需要重新生成）

- `packages/protocol/src/generated/proto/Mumble.ts`
- `packages/protocol/src/generated/proto/HubEdge.ts`
- `packages/protocol/src/generated/proto/HubEdgeRPC.ts`
- `packages/protocol/src/generated/proto/HubEdgeSync.ts`

## 5. 迁移执行计划

### 5.1 准备阶段

1. **创建迁移分支**
   ```bash
   git checkout -b feat/migrate-to-ts-proto
   ```

2. **备份当前生成的文件**
   ```bash
   cp -r packages/protocol/src/generated/proto packages/protocol/src/generated/proto.backup
   ```

3. **安装新依赖**
   ```bash
   cd packages/protocol
   pnpm remove google-protobuf @types/google-protobuf protoc-gen-ts
   pnpm add -D ts-proto
   cd ../..
   pnpm install
   ```

### 5.2 代码生成阶段

1. **更新生成脚本** (见 3.2 节)

2. **重新生成 protobuf 代码**
   ```bash
   cd packages/protocol
   pnpm run clean
   pnpm run generate:proto
   ```

3. **验证生成的代码**
   ```bash
   # 检查生成的文件是否存在
   ls -la src/generated/proto/
   
   # 快速检查接口定义
   head -n 50 src/generated/proto/Mumble.ts
   ```

### 5.3 代码迁移阶段

按以下顺序依次修改每个文件：

#### 第一批：Protocol Package（核心）

1. `packages/protocol/src/rpc/typed-rpc-client.ts`
2. `packages/protocol/src/rpc/typed-rpc-server.ts`
3. 编译测试：`cd packages/protocol && pnpm run build`

#### 第二批：Edge Server

4. `packages/edge-server/src/auth/auth-handler.ts`
5. `packages/edge-server/src/handlers/state-handlers.ts`
6. `packages/edge-server/src/message-handler.ts`
7. `packages/edge-server/src/managers/event-setup-manager.ts`
8. 编译测试：`cd packages/edge-server && pnpm run build`

#### 第三批：Hub Server

9. `packages/hub-server/src/relay/client-message-router.ts`
10. 编译测试：`cd packages/hub-server && pnpm run build`

#### 第四批：Client

11. `packages/client/src/core/mumble-client.ts`
12. 编译测试：`cd packages/client && pnpm run build`

### 5.4 测试阶段

1. **编译所有 packages**
   ```bash
   pnpm run build
   ```

2. **运行单元测试**
   ```bash
   pnpm test:unit
   ```

3. **运行集成测试**
   ```bash
   pnpm test:integration
   ```

4. **手动测试关键路径**
   - Hub-Edge 连接
   - 用户认证
   - 频道操作
   - 消息传递

### 5.5 清理阶段

1. **删除备份文件**
   ```bash
   rm -rf packages/protocol/src/generated/proto.backup
   ```

2. **更新文档**
   - 更新 README.md 中的依赖说明
   - 更新开发者文档中的 protobuf 生成说明

3. **提交代码**
   ```bash
   git add .
   git commit -m "feat: migrate from google-protobuf to ts-proto"
   ```

## 6. 潜在问题和解决方案

### 6.1 字段名不匹配

**问题**: 忘记将 `snake_case` 转换为 `camelCase`

**解决**: 
- **推荐方案**：使用 `snakeToCamel=false` 保持 snake_case，无需任何字段名转换
- 如果已经使用了默认的 camelCase 转换，使用 IDE 的批量查找替换，或编写脚本辅助转换：

```bash
# 查找所有可能未转换的字段访问
grep -r "\.channel_id\|\.user_id\|\.session_id" packages/*/src --include="*.ts"
```

### 6.2 Optional 字段语义变化

**问题**: `has_field_name` 和 `field !== undefined` 在某些边缘情况下行为不同

**解决**: 仔细检查所有 optional 字段的使用场景，确保逻辑正确

### 6.3 性能差异

**问题**: 序列化/反序列化性能可能有差异

**解决**: 运行性能测试，如发现问题可调整 ts-proto 配置选项

### 6.4 类型兼容性

**问题**: 某些代码可能依赖 Message 类的特定方法

**解决**: 使用 ts-proto 提供的工厂方法替代，如 `create()`, `fromPartial()`

### 6.5 JSON 序列化差异

**问题**: `toObject()` 和 `toJSON()` 输出格式可能略有不同

**解决**: 
- `toJSON()` 遵循 proto3 JSON 规范
- 如需要原始对象，直接使用消息本身（它已经是普通对象）

## 7. 配置选项详解

### 7.1 已选用的参数（非默认值）

```bash
--ts_proto_opt=\
  outputServices=generic-definitions,\  # 生成通用服务定义（默认不生成）
  outputClientImpl=false,\              # 不生成客户端实现（默认 true）
  esModuleInterop=true,\                # ESModule 兼容（默认 false）
  env=node,\                            # Node.js 环境（默认 both）
  useOptionals=messages,\               # 消息字段可选（默认 none）
  oneof=unions-value,\                  # oneof 生成 ADT（默认 properties）
  snakeToCamel=false,\                  # 保持 snake_case（默认 true）
  forceLong=number,\                    # 64位用 number（默认值，明确声明）
  useExactTypes=true,\                  # 精确类型检查（默认值，明确声明）
  outputPartialMethods=true             # 生成 fromPartial（默认值，明确声明）
```

### 7.2 默认值参数（无需配置，但重要）

以下参数使用默认值，符合项目需求：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `outputEncodeMethods` | `true` | 生成 encode/decode 方法 |
| `outputJsonMethods` | `true` | 生成 fromJSON/toJSON 方法 |
| `stringEnums` | `false` | 使用数字枚举（符合 protobuf） |
| `useDate` | `true` | Timestamp → Date 对象 |
| `useMapType` | `false` | 使用对象而非 Map |
| `useReadonlyTypes` | `false` | 字段可变 |
| `initializeFieldsAsUndefined` | `true` | 初始化为 undefined（性能优化） |
| `exportCommonSymbols` | `true` | 导出通用类型 |
| `onlyTypes` | `false` | 生成完整代码，不仅是类型 |

### 7.3 不适用的参数

以下参数不适用于本项目：

- `nestJs=true` - 不使用 NestJS
- `outputClientImpl=grpc-web` - 不使用 grpc-web
- `returnObservable=true` - 不使用 Observable
- `useAsyncIterable=true` - 不使用 AsyncIterable
- `stringEnums=true` - 枚举应该用数字（protobuf 规范）
- `useMapType=true` - 保持对象类型，更灵活
- `useReadonlyTypes=true` - 需要可变字段

### 7.4 特殊场景参数（暂不启用）

如未来有特殊需求，可考虑：

- `useDate=false` - 如需保留时间戳的纳秒精度
- `forceLong=bigint` - 如需处理超大整数
- `unknownFields=true` - 如需保留未知字段
- `outputExtensions=true` - 如需支持 proto2 扩展
- `usePrototypeForDefaults=true` - 如需检测默认值应用

## 8. 回滚计划

如果迁移过程中遇到无法解决的问题：

1. **恢复依赖**
   ```bash
   cd packages/protocol
   pnpm add google-protobuf@3.21.4
   pnpm add -D @types/google-protobuf protoc-gen-ts
   pnpm remove ts-proto
   ```

2. **恢复生成脚本** (package.json)

3. **恢复生成的代码**
   ```bash
   rm -rf packages/protocol/src/generated/proto
   cp -r packages/protocol/src/generated/proto.backup packages/protocol/src/generated/proto
   ```

4. **重新生成**
   ```bash
   cd packages/protocol
   pnpm run generate:proto
   ```

5. **回滚代码更改**
   ```bash
   git checkout -- .
   ```

## 9. 迁移后的优势

完成迁移后，项目将获得以下优势：

1. **更好的类型安全**: 纯 TypeScript 接口，编译时捕获更多错误
2. **更简洁的代码**: 使用对象字面量而非类实例，代码更简洁
3. **更好的性能**: 底层使用 `@bufbuild/protobuf`，性能优于 `google-protobuf`
4. **更小的包体积**: 生成的代码更精简
5. **更好的开发体验**: 更符合现代 TypeScript 开发习惯
6. **更活跃的维护**: ts-proto 社区更活跃，更新更频繁

## 10. 参考资源

- [ts-proto GitHub](https://github.com/stephenh/ts-proto)
- [ts-proto 文档](https://github.com/stephenh/ts-proto/blob/main/README.markdown)
- [@bufbuild/protobuf](https://www.npmjs.com/package/@bufbuild/protobuf)
- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)

---

**文档版本**: 1.0  
**最后更新**: 2024-12-20  
**作者**: GitHub Copilot
