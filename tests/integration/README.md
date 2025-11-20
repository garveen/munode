# 集成测试

## 目录结构

```
tests/integration/
├── README.md              # 本文档
├── setup.ts              # 测试环境设置（启动/停止服务器）
├── helpers.ts            # 测试辅助函数（连接、断言等）
├── fixtures.ts           # 测试数据和常量
├── test-integration.ts   # 主集成测试入口
└── suites/               # 测试套件
    ├── auth.test.ts      # 认证测试
    ├── channel.test.ts   # 频道管理测试
    ├── acl.test.ts       # 权限测试
    ├── voice.test.ts     # 语音传输测试
    └── hub-edge.test.ts  # Hub-Edge 通信测试
```

## 测试框架

集成测试使用以下工具：
- **测试框架**: 待定（推荐 Vitest 或 Jest）
- **测试环境**: 自动启动本地 Hub 和 Edge 服务器
- **清理机制**: 测试后自动清理服务器进程和临时数据

## 编写测试

### 基本结构

```typescript
import { setupTestEnvironment } from './setup';
import { createMumbleConnection } from './helpers';
import { TEST_CONFIG, TEST_USERS } from './fixtures';

describe('功能模块', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('测试用例', async () => {
    // 连接到服务器
    const conn = await createMumbleConnection(
      TEST_CONFIG.edge.host,
      TEST_CONFIG.edge.port
    );

    // 执行测试逻辑
    // ...

    // 清理
    conn.close();
  });
});
```

### 测试类型

1. **认证测试** (`auth.test.ts`)
   - 用户名/密码登录
   - 密码验证
   - 证书认证
   - Token 刷新
   - **边界情况**: 并发认证、频率限制、证书过期、服务器不可用

2. **频道管理测试** (`channel.test.ts`)
   - 创建/删除频道
   - 移动用户
   - 频道树结构
   - 临时频道
   - **边界情况**: 名称冲突、长度限制、深层嵌套、权限验证

3. **权限测试** (`acl.test.ts`)
   - ACL 继承
   - 权限检查
   - 组权限
   - 频道权限
   - **边界情况**: 权限缓存、复杂继承、组循环依赖、权限过期

4. **语音传输测试** (`voice.test.ts`)
   - 语音包编码/解码
   - 语音路由
   - 语音目标
   - 静音/禁音
   - **边界情况**: 包大小限制、编解码器切换、路由循环、权限验证

5. **Hub-Edge 通信测试** (`hub-edge.test.ts`)
   - RPC 调用
   - 状态同步
   - 负载均衡
   - 故障恢复
   - **边界情况**: 网络延迟、消息顺序、容量限制、部分故障

## 运行测试

```bash
# 运行所有集成测试
pnpm run test:integration

# 运行特定测试套件
pnpm run test:integration -- auth.test.ts

# 监听模式
pnpm run test:integration -- --watch
```

## 注意事项

1. **端口冲突**: 确保测试端口未被占用
2. **并发执行**: 避免多个测试同时修改共享状态
3. **超时设置**: 集成测试可能需要较长时间，适当增加超时
4. **清理机制**: 每个测试后清理创建的资源
5. **隔离性**: 测试之间应该相互独立，不依赖执行顺序

## 用户操作测试验证要求

**所有与用户操作相关的测试都必须验证三种情况：**

1. **操作人自身**: 验证操作发起者是否正确接收到操作结果或确认消息，如果消息会回传数据
2. **本 Edge 其它用户**: 如果操作涉及消息广播，验证同一 Edge 服务器上的其他用户是否能接收到消息
3. **其它 Edge 用户**: 如果操作涉及消息广播，验证其他 Edge 服务器上的用户是否能接收到消息

### 适用场景

以下类型的测试必须遵循上述验证要求：

- **用户状态变更** (如用户名、静音状态、频道移动等)
- **频道操作** (创建、删除、属性变更等)
- **语音传输** (语音包、语音目标等)
- **权限变更** (ACL 更新、组权限等)
- **文本消息** (频道消息、私聊等)

### 验证示例

```typescript
describe('User State Changes', () => {
  it('should broadcast user state change to all connected users', async () => {
    // 连接多个用户：操作者 + 本Edge用户 + 其他Edge用户
    const operator = await createMumbleConnection(...);
    const localUser = await createMumbleConnection(...);
    const remoteUser = await createMumbleConnection(...); // 连接到不同Edge
    
    // 执行操作（例如：用户改名）
    await operator.sendUserStateUpdate({ name: 'newName' });
    
    // 验证1: 操作人自身收到确认
    await expect(operator.receive()).resolves.toMatchObject({
      type: MessageType.UserState,
      // 操作人自己的状态更新
    });
    
    // 验证2: 本Edge其他用户收到广播
    await expect(localUser.receive()).resolves.toMatchObject({
      type: MessageType.UserState,
      // 其他用户的状态更新广播
    });
    
    // 验证3: 其他Edge用户收到广播
    await expect(remoteUser.receive()).resolves.toMatchObject({
      type: MessageType.UserState,
      // 跨Edge的状态更新广播
    });
  });
});
```

### 验证要点

- **消息顺序**: 确保消息按预期顺序到达
- **消息内容**: 验证消息内容准确无误
- **延迟容忍**: 允许合理的网络延迟，但不超过预期阈值
- **错误处理**: 验证网络分区或服务器故障时的行为

## 调试

```typescript
// 启用详细日志
process.env.DEBUG = 'munode:*';

// 保留服务器进程用于手动测试
const testEnv = await setupTestEnvironment();
// 不调用 testEnv.cleanup()
```
