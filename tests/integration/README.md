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

## 快速开始

### 1. 构建项目（必需）

```bash
pnpm build
```

### 2. 运行所有集成测试

```bash
pnpm test:integration
```

### 3. 运行特定测试文件

```bash
pnpm test:integration tests/integration/suites/listening-channel.test.ts
```

### 4. 监视模式运行

```bash
pnpm test:integration:watch
```

### 5. 查看测试覆盖率

```bash
pnpm test:integration -- --coverage
```

### 6. 验证新增测试（使用脚本）

```bash
./scripts/verify-new-tests.sh
```

## 注意事项

1. **端口冲突**: 确保测试端口未被占用
2. **并发执行**: 避免多个测试同时修改共享状态
3. **超时设置**: 集成测试可能需要较长时间，适当增加超时
4. **清理机制**: 每个测试后清理创建的资源
5. **隔离性**: 测试之间应该相互独立，不依赖执行顺序

## 用户操作测试验证要求

**所有与用户操作相关的测试都必须验证两种情况：** ✅ 已实现

1. **本 Edge 其它用户**: 验证同一 Edge 服务器上的其他用户是否能接收到消息/状态更新
2. **其它 Edge 用户**: 验证其他 Edge 服务器上的用户是否能接收到消息/状态更新

### 测试模式

所有涉及消息广播或状态同步的测试现在都使用以下模式：

```typescript
describe('Feature Tests', () => {
  it('should broadcast changes across edges', async () => {
    // 连接3个客户端
    const client1 = new MumbleClient(); // 操作者 - Edge 1
    const client2 = new MumbleClient(); // 本 Edge 观察者 - Edge 1
    const client3 = new MumbleClient(); // 跨 Edge 观察者 - Edge 2
    
    await client1.connect({ host: 'localhost', port: testEnv.edgePort, ... });
    await client2.connect({ host: 'localhost', port: testEnv.edgePort, ... });
    await client3.connect({ host: 'localhost', port: testEnv.edgePort2, ... }); // 注意: edgePort2
    
    // 设置本 Edge 监听
    let receivedLocal = false;
    const promiseLocal = new Promise<void>((resolve) => {
      client2.on('event', (data) => {
        receivedLocal = true;
        resolve();
      });
    });
    
    // 设置跨 Edge 监听
    let receivedRemote = false;
    const promiseRemote = new Promise<void>((resolve) => {
      client3.on('event', (data) => {
        receivedRemote = true;
        resolve();
      });
    });
    
    // 执行操作
    await client1.performAction();
    
    // 并行等待两个接收
    await Promise.all([
      Promise.race([promiseLocal, new Promise(resolve => setTimeout(resolve, 2000))]),
      Promise.race([promiseRemote, new Promise(resolve => setTimeout(resolve, 2000))])
    ]);
    
    // 验证：本 Edge 和跨 Edge 都接收到
    expect(receivedLocal).toBe(true);
    expect(receivedRemote).toBe(true);
    
    await client1.disconnect();
    await client2.disconnect();
    await client3.disconnect();
  });
});
```

### 已实现的跨 Edge 测试

以下测试已经实现了本 Edge 和跨 Edge 双重验证：

#### voice.test.ts ✅
- `should handle mute/deafen states across edges` - 静音状态同步
- `should handle self deafen state across edges` - 耳聋状态同步
- `should handle recording state across edges` - 录音状态同步

#### channel.test.ts ✅
- `should move users between channels and broadcast to all edges` - 频道移动同步

#### listening-channel.test.ts ✅
- `should add listening channel and broadcast to all edges` - 监听频道同步

#### moderation.test.ts ✅
- `should send and receive text messages across edges` - 频道消息广播
- `should send private message to specific user across edges` - 跨 Edge 私聊

#### hub-edge.test.ts ✅
- `should handle user disconnection across edges` - 用户断开同步

#### plugin.test.ts ✅
- `should send plugin data to all users across edges` - 插件数据广播

### 测试环境说明

每个测试套件会自动启动以下服务：
- **1个认证服务器** (端口: basePort)
- **1个 Hub 服务器** (端口: basePort + 1000)
- **2个 Edge 服务器** (端口: basePort + 2000 和 basePort + 2100)

例如，basePort = 8080 时：
- 认证: 8080
- Hub: 9080
- Edge 1: 10080
- Edge 2: 10180

## 调试

```typescript
// 启用详细日志
process.env.DEBUG = 'munode:*';

// 保留服务器进程用于手动测试
const testEnv = await setupTestEnvironment();
// 不调用 testEnv.cleanup()
```
