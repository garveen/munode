# MuNode 项目 Copilot 指导

## 项目概述

MuNode 是一个基于 Node.js/TypeScript 的 Mumble 服务器实现，采用 Hub-Edge 分布式架构。本项目使用 pnpm workspace 管理 monorepo。

## 项目架构

### Packages 结构
- `@munode/common`: 共享工具类、类型定义、配置管理、日志系统、心跳机制
- `@munode/protocol`: Protocol Buffers 定义和类型安全的 RPC 通信
- `@munode/hub-server`: Hub 服务器 - 中心管理节点，负责用户认证、权限管理、数据持久化
- `@munode/edge-server`: Edge 服务器 - 边缘节点，处理实时语音/数据传输、客户端连接
- `@munode/cli`: 命令行工具

### 核心技术栈
- **语言**: TypeScript (严格模式)
- **运行时**: Node.js
- **包管理**: pnpm workspace
- **协议**: Protocol Buffers, Mumble Protocol
- **通信**: gRPC, TCP, UDP, WebSocket
- **加密**: OCB2-AES128, TLS
- **数据库**: SQLite (Hub), JSON (配置/数据)

## 编码规范

### TypeScript 风格
```typescript
// 使用严格类型定义
interface UserState {
  session: number;
  name: string;
  channelId: number;
}

// 优先使用 interface 而非 type
interface ILogger {
  info(message: string): void;
  error(message: string, error?: Error): void;
}

// 使用枚举表示常量集合
enum PermissionFlag {
  None = 0,
  Write = 1,
  Traverse = 2,
  Enter = 4,
}
```

### 命名约定
- **类名**: PascalCase (如 `EdgeServer`, `HubClient`)
- **接口**: PascalCase, 可选 `I` 前缀 (如 `IConfig`, `ClientState`)
- **方法/函数**: camelCase (如 `handleMessage`, `broadcastUserState`)
- **常量**: UPPER_SNAKE_CASE (如 `MAX_CONNECTIONS`, `DEFAULT_PORT`)
- **文件名**: kebab-case (如 `edge-server.ts`, `auth-manager.ts`)

### 异步处理
```typescript
// 优先使用 async/await
async function authenticateUser(token: string): Promise<User> {
  try {
    const user = await validateToken(token);
    return user;
  } catch (error) {
    logger.error('Authentication failed', error);
    throw new Error('Invalid token');
  }
}

// 对于并发操作使用 Promise.all
await Promise.all([
  saveUser(user),
  updateChannel(channel),
  notifyClients(message)
]);
```

### 错误处理
```typescript
// 使用类型化的错误
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// 在关键路径记录错误
try {
  await criticalOperation();
} catch (error) {
  logger.error('Operation failed', error);
  // 决定是否重新抛出或优雅降级
}
```

### 日志规范
```typescript
// 使用统一的日志接口
logger.info('User connected', { session, username });
logger.warn('Unusual activity detected', { userId, action });
logger.error('Failed to process message', { error, context });
logger.debug('State update', { state }); // 仅开发/调试模式
```

## 架构模式

### Hub-Edge 通信
```typescript
// Edge -> Hub: 使用类型安全的 RPC
await hubClient.rpc.authenticateUser({
  username: 'user',
  password: 'pass'
});

// Hub -> Edge: 通过控制通道广播
hubServer.broadcastToEdges({
  type: 'USER_STATE_UPDATE',
  payload: userState
});
```

### 权限系统 (ACL)
```typescript
// 检查权限时考虑继承
function hasPermission(
  user: User,
  channel: Channel,
  permission: PermissionFlag
): boolean {
  // 检查直接权限
  if (channel.acl.hasPermission(user, permission)) return true;
  
  // 检查继承的权限
  if (channel.inheritACL) {
    return hasPermission(user, channel.parent, permission);
  }
  
  return false;
}
```

### 集群同步
```typescript
// 状态变更需要同步到所有节点
async function updateUserState(session: number, state: Partial<UserState>) {
  // 本地更新
  this.users.set(session, { ...currentState, ...state });
  
  // 集群广播
  await this.clusterManager.broadcast({
    type: 'USER_STATE_SYNC',
    session,
    state
  });
}
```

## 测试指导

### 单元测试
```typescript
import { describe, it, expect } from 'vitest';

describe('AuthManager', () => {
  it('should validate correct credentials', async () => {
    const authManager = new AuthManager(config);
    const result = await authManager.authenticate('user', 'pass');
    expect(result.success).toBe(true);
  });
});
```

### 集成测试

#### 运行集成测试
```bash
# 构建项目（必须先构建）
pnpm build

# 运行所有集成测试
pnpm test:integration

# 以监视模式运行集成测试
pnpm test:integration:watch

# 运行集成测试并查看覆盖率
pnpm test:integration -- --coverage

# 运行特定的测试文件
pnpm test:integration tests/integration/suites/auth.test.ts
```

#### 集成测试结构
- **测试套件位置**: `tests/integration/suites/`
  - `auth.test.ts` - 认证和授权测试
  - `acl.test.ts` - ACL 权限系统测试
  - `channel.test.ts` - 频道管理测试
  - `voice.test.ts` - 语音传输测试
  - `hub-edge.test.ts` - Hub-Edge 通信测试

- **旧测试文件位于根目录**: `test-*.js`, `test-*.ts`（可能需要迁移）

#### 集成测试配置
- 配置文件: `vitest.config.integration.ts`
- 测试超时: 30秒
- Hook 超时: 60秒
- 运行模式: 单进程 (避免端口冲突)

#### 编写集成测试
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Feature Integration Tests', () => {
  let hubServer;
  let edgeServer;

  beforeAll(async () => {
    // 启动 Hub 和 Edge 服务器
    hubServer = await startHubServer();
    edgeServer = await startEdgeServer();
  });

  afterAll(async () => {
    // 清理资源
    await edgeServer.stop();
    await hubServer.stop();
  });

  it('should handle feature correctly', async () => {
    // 测试逻辑
    const result = await testFeature();
    expect(result).toBe(expected);
  });
});
```

#### 集成测试最佳实践
1. **测试隔离**: 每个测试套件使用独立的服务器实例和端口
2. **资源清理**: 在 `afterAll` 中清理所有资源（服务器、连接、文件等）
3. **超时设置**: 集成测试通常需要较长超时，已配置为 30 秒
4. **错误处理**: 捕获并记录详细的错误信息以便调试
5. **测试数据**: 使用临时数据库和配置文件，测试后清理

#### 常见集成测试场景
- Hub-Edge 连接和断开
- 用户认证流程（包含外部认证 API）
- ACL 权限继承和检查
- 频道创建、移动、删除
- 用户状态同步（跨 Edge）
- 语音包路由和转发
- 文本消息广播
- 用户组和权限管理

## Protocol Buffers

### 消息定义
```protobuf
// 所有 .proto 文件位于 packages/protocol/proto/
message UserState {
  uint32 session = 1;
  string name = 2;
  uint32 channel_id = 3;
}
```

### 类型安全 RPC
```typescript
// 使用生成的类型化 RPC 客户端
const client = new TypedRpcClient<HubRpcInterface>(connection);
const response = await client.call('methodName', { param: value });
```

## 常见模式

### 客户端连接管理
```typescript
class Client {
  private session: number;
  private state: ClientState;
  private socket: TLSSocket;
  
  async handleMessage(message: MumbleMessage): Promise<void> {
    // 解析消息类型并路由到相应处理器
  }
  
  async sendMessage(message: MumbleMessage): Promise<void> {
    // 序列化并发送，处理背压
  }
}
```

### 频道树管理
```typescript
class ChannelManager {
  private channels: Map<number, Channel>;
  
  createChannel(parent: Channel, name: string): Channel {
    // 创建频道，设置 ACL 继承
  }
  
  moveUser(user: User, targetChannel: Channel): void {
    // 检查权限，更新状态，广播变更
  }
}
```

### 配置加载
```typescript
// 使用 @munode/common 的配置工具
import { loadConfig } from '@munode/common';

const config = await loadConfig<EdgeConfig>('config/edge.json');
```

## 性能注意事项

- **UDP 语音包**: 最小化处理延迟，避免阻塞操作
- **连接数**: Edge 支持大量并发连接，使用事件驱动模式
- **内存管理**: 定期清理断开的客户端状态
- **数据库**: Hub 使用 SQLite，避免 N+1 查询，使用事务批量操作

## 安全考虑

- **认证**: Hub 集中管理用户认证，Edge 信任 Hub 的认证结果
- **加密**: 客户端连接强制 TLS，语音使用 OCB2-AES128
- **权限**: 所有操作检查 ACL 权限，支持频道级继承
- **输入验证**: 验证所有外部输入，防止注入攻击

## 调试提示

```typescript
// 启用调试日志
process.env.DEBUG = 'munode:*';

// 使用 VSCode 调试配置
// .vscode/launch.json 中配置了各服务的调试入口

// 查看 Protocol Buffers 消息
console.log(JSON.stringify(message.toJSON(), null, 2));
```

## 依赖管理

```bash
# 在根目录安装依赖
pnpm install

# 添加依赖到特定 package
pnpm --filter @munode/edge-server add library-name

# 运行特定 package 的脚本
pnpm --filter @munode/hub-server run build
```

## 文档参考

- 架构文档: `docs/` 目录
- 实现状态: 根目录 `*_IMPLEMENTATION*.md` 文件
- API 文档: 各 package 的 README.md
- RPC 使用: `packages/protocol/TYPED_RPC_USAGE.md`

## 常见问题

**Q: Edge 和 Hub 如何通信?**
A: Edge 通过 gRPC (类型安全 RPC) 与 Hub 通信，用于认证、权限查询等；Hub 通过控制通道向 Edge 推送状态更新。

**Q: 用户状态如何同步?**
A: 用户状态变更在 Edge 本地处理，然后通过 Hub 广播到所有相关 Edge 节点，确保最终一致性。

**Q: 如何添加新的 RPC 方法?**
A: 在 `packages/protocol/proto/` 定义消息，在 Hub 实现处理器，Edge 通过类型化客户端调用。

**Q: 测试时如何模拟 Hub-Edge 环境?**
A: 使用集成测试启动本地 Hub 和 Edge 实例，或使用 mock 对象模拟 RPC 调用。
