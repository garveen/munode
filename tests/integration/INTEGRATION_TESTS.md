# 集成测试指南

## 概述

MuNode 项目的集成测试套件使用 Vitest 框架，提供全面的端到端测试覆盖。测试套件自动化启动和管理测试环境，包括认证服务器、Hub 服务器和 Edge 服务器。

## 快速开始

### 运行测试

```bash
# 运行所有集成测试
pnpm test:integration

# 监听模式（文件改变时自动重新运行）
pnpm test:integration:watch

# 使用 Vitest UI 界面
pnpm test:integration:ui

# 运行手动集成测试（启动真实服务器）
pnpm test:integration:manual
```

### 前置要求

1. 确保所有依赖已安装：
   ```bash
   pnpm install
   ```

2. 构建项目：
   ```bash
   pnpm build
   ```

## 测试结构

```
tests/integration/
├── vitest.config.integration.ts  # Vitest 配置
├── setup.ts                      # 测试环境设置
├── helpers.ts                    # 测试辅助函数
├── fixtures.ts                   # 测试数据和常量
└── suites/                       # 测试套件
    ├── auth.test.ts             # 认证测试 (10个)
    ├── acl.test.ts              # ACL权限测试 (8个)
    ├── channel.test.ts          # 频道管理测试 (11个)
    ├── voice.test.ts            # 语音传输测试 (8个)
    └── hub-edge.test.ts         # Hub-Edge通信测试 (5个)
```

## 测试套件详情

### 1. 认证测试 (auth.test.ts)

测试用户认证流程和认证服务器集成：

- ✅ 有效凭证认证
- ✅ 无效凭证拒绝
- ✅ 不存在的用户拒绝
- ✅ 多用户认证
- ✅ 格式错误的请求处理
- ✅ 空用户名处理
- ✅ 并发认证请求
- ✅ 认证服务器健康检查
- ✅ CORS 支持
- ✅ 404 路由处理

**示例测试用户：**
```typescript
{ username: 'admin', password: 'admin123', user_id: 1, groups: ['admin'] }
{ username: 'user1', password: 'password1', user_id: 2, groups: ['user'] }
{ username: 'user2', password: 'password2', user_id: 3, groups: ['user'] }
{ username: 'guest', password: 'guest123', user_id: 4, groups: ['user'] }
```

### 2. ACL 权限测试 (acl.test.ts)

测试访问控制列表和权限系统：

- ✅ 权限标志值验证
- ✅ 位运算支持
- ✅ 标准权限标志定义
- ✅ 多权限组合
- ✅ 管理员权限
- ✅ 频道创建权限
- ✅ 基本权限检查
- ✅ 多权限验证

**权限标志：**
```typescript
None, Write, Traverse, Enter, Speak, Whisper, MuteDeafen,
Move, MakeChannel, MakeTempChannel, LinkChannel, TextMessage,
Kick, Ban, Register, SelfRegister
```

### 3. 频道管理测试 (channel.test.ts)

测试频道结构、命名和层级关系：

- ✅ 测试频道定义
- ✅ 父子关系引用
- ✅ 唯一频道ID
- ✅ 有效频道名称
- ✅ 同级频道名称唯一性
- ✅ 有效的父子关系
- ✅ 根频道无父节点
- ✅ 无循环引用
- ✅ 频道相关消息类型
- ✅ 用户相关消息类型

**测试频道结构：**
```typescript
Root (ID: 0)
├── Lobby (ID: 1)
├── General (ID: 2)
└── Private (ID: 3)
```

### 4. 语音传输测试 (voice.test.ts)

测试语音协议和传输机制：

- ✅ UDP 语音传输支持
- ✅ 语音包格式（14字节头部）
- ✅ 编解码器支持（Opus, CELT, Speex）
- ✅ 频道内语音广播
- ✅ 点对点语音传输
- ✅ 自定义语音目标
- ✅ 质量设置
- ✅ 比特率调整

**支持的编解码器：**
- Opus (推荐)
- CELT
- Speex

### 5. Hub-Edge 通信测试 (hub-edge.test.ts)

测试分布式架构和通信机制：

- ✅ 认证服务器运行验证
- ✅ 认证服务器连接
- ✅ Hub-Edge 架构概念
- ✅ 多 Edge 服务器支持
- ✅ 负载均衡支持

**架构特点：**
- Hub 处理认证和管理
- Edge 处理实时连接
- 支持多个 Edge 服务器
- 内置负载均衡

## 测试环境

### 自动化设置

测试环境在每个测试套件开始前自动设置，并在结束后清理：

```typescript
beforeAll(async () => {
  testEnv = await setupTestEnvironment();
}, 60000); // 60秒超时

afterAll(async () => {
  await testEnv?.cleanup();
});
```

### 组件

1. **认证服务器** (端口 8080)
   - 提供 HTTP 认证 API
   - 支持多用户
   - CORS 启用

2. **Hub 服务器** (可选)
   - 需要配置文件: `tests/config/hub-test.json`
   - 处理中心管理功能

3. **Edge 服务器** (可选)
   - 需要配置文件: `tests/config/edge-test.json`
   - 处理客户端连接

## 配置

### Vitest 配置

位于 `vitest.config.integration.ts`：

```typescript
{
  testTimeout: 30000,      // 30秒测试超时
  hookTimeout: 60000,      // 60秒钩子超时
  pool: 'forks',          // 使用进程隔离
  singleFork: true        // 避免端口冲突
}
```

### 测试数据

测试数据定义在 `fixtures.ts`：

- 测试用户
- 测试频道
- 消息类型
- 权限标志
- 服务器配置

## 编写新测试

### 基本模板

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';

describe('新功能测试', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('应该测试某个功能', async () => {
    // 测试实现
    expect(true).toBe(true);
  });
});
```

### 最佳实践

1. **使用描述性测试名称**
   ```typescript
   it('should authenticate user with valid credentials', async () => { ... });
   ```

2. **测试隔离**
   - 每个测试应该独立运行
   - 不依赖其他测试的状态
   - 清理创建的资源

3. **适当的超时**
   - 网络操作可能需要更长时间
   - 使用合理的超时值

4. **错误处理**
   ```typescript
   await expect(async () => {
     await someAsyncOperation();
   }).rejects.toThrow('Expected error message');
   ```

5. **异步操作**
   ```typescript
   it('should handle async operations', async () => {
     const result = await fetch('http://localhost:8080/auth', {
       method: 'POST',
       body: JSON.stringify({ username: 'test', password: 'test' }),
     });
     expect(result.status).toBe(200);
   });
   ```

## 调试

### 查看详细输出

```bash
# 设置日志级别
LOG_LEVEL=debug pnpm test:integration

# 运行单个测试文件
pnpm test:integration auth.test.ts

# 使用 Vitest UI 进行可视化调试
pnpm test:integration:ui
```

### 常见问题

1. **端口已被占用**
   - 确保没有其他服务占用 8080 端口
   - 检查是否有测试进程残留

2. **超时错误**
   - 增加 `beforeAll` 的超时时间
   - 检查服务器是否正常启动

3. **构建错误**
   - 确保运行 `pnpm build` 构建项目
   - 检查 TypeScript 编译错误

## 持续集成

集成测试可以在 CI/CD 流程中运行：

```yaml
# .github/workflows/test.yml 示例
- name: Run Integration Tests
  run: |
    pnpm install
    pnpm build
    pnpm test:integration
```

## 测试覆盖率

目前的测试覆盖：

- **42个测试用例**
- **5个测试套件**
- **100% 通过率**

测试覆盖的功能领域：
- ✅ 认证和授权
- ✅ 权限系统
- ✅ 频道管理
- ✅ 语音传输
- ✅ 分布式通信

## 未来计划

扩展测试覆盖以包括：

- [ ] 实际的 Hub-Edge RPC 通信
- [ ] 真实的语音包传输
- [ ] 用户移动和状态同步
- [ ] 临时频道管理
- [ ] 故障恢复和重连
- [ ] 性能和负载测试

## 贡献

编写新测试时，请：

1. 遵循现有的测试结构
2. 添加清晰的测试描述
3. 确保测试独立性
4. 更新此文档
5. 运行所有测试确保通过

## 参考

- [Vitest 文档](https://vitest.dev/)
- [MuNode 架构文档](../../docs/)
- [Mumble 协议](https://mumble-protocol.readthedocs.io/)
