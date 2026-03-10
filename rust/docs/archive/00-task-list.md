# MuNode Rust 重写任务列表

> 目标：使用现有的 TypeScript MumbleClient，通过所有 TS 集成测试用例。
> 测试文件位于 `tests/integration/suites/`，通过 `pnpm test:integration` 运行。

## 总体策略

集成测试框架（`tests/integration/setup.ts`）目前直接实例化 TypeScript 的 `EdgeServer` 和 `HubServer`。
适配方案：通过环境变量 `MUNODE_USE_RUST=1` 切换为启动 Rust 编译后的二进制进程。
TypeScript `MumbleClient` 保持不变，继续用于测试验证。

```
                    集成测试 (Vitest)
                         │
              ┌──────────┴──────────┐
              │                     │
   MUNODE_USE_RUST=0           MUNODE_USE_RUST=1
   (默认, TS 服务器)             (Rust 二进制)
              │                     │
     new HubServer()          spawn munode-hub
     new EdgeServer()         spawn munode-edge
              │                     │
              └──────────┬──────────┘
                         │
               MumbleClient (TS) 连接测试
```

---

## 任务列表

### P0 - 核心基础设施（阻塞所有测试）

- [x] **T1: 集成测试基础设施适配**
  - 修改 `tests/integration/setup.ts`，支持 `MUNODE_USE_RUST=1` 模式
  - 添加 `RustProcess` 封装，管理 Hub/Edge Rust 进程的生命周期
  - 生成临时 JSON 配置文件供 Rust 进程使用
  - 实现进程启动/停止/健康检查（端口监听确认）
  - 参考文档：[01-test-integration-design.md](01-test-integration-design.md)

- [x] **T2: Rust Hub HTTP 认证 URL 支持**
  - 当前 Rust Hub 仅支持 WebSocket 外部认证服务
  - 集成测试启动 HTTP 认证服务器（`TestAuthServer`），Hub 需通过 HTTP POST 调用认证
  - 在 `HubAuthConfig` 中添加 `http_url: Option<String>` 字段
  - 在 `rpc_handler.rs` 中当 `http_url` 设置时调用 HTTP 认证端点
  - HTTP 请求格式：`{ username, password, tokens, server_id }` → `{ success, user_id, username, groups }`

- [x] **T3: Rust 进程测试数据库初始化**
  - TS 测试使用 `scripts/init-test-db.ts` 初始化 SQLite 数据库（用户、频道、ACL）
  - Rust Hub 使用相同的 SQLite 格式，可共用同一数据库文件
  - 确保 Rust Hub 启动时正确加载已初始化的数据库

### P1 - 主要功能测试覆盖

- [ ] **T4: 测试覆盖验证 - hub-edge.test.ts**
  - Hub-Edge 连接、Mumble 协议连接、并发连接测试
  - Rust 实现已完成相应功能，需验证测试通过

- [ ] **T5: 测试覆盖验证 - auth.test.ts**
  - HTTP 认证服务器测试（T2 实现后可通过）
  - PreConnectUserState 测试（Rust 实现需确认）

- [ ] **T6: 测试覆盖验证 - channel.test.ts**
  - 频道结构、创建/删除、用户移动
  - Rust 实现已完成相应功能，需验证测试通过

- [ ] **T7: 测试覆盖验证 - acl.test.ts / acl-operations.test.ts / acl-suppress.test.ts**
  - ACL 权限检查、继承、suppress 状态
  - Rust ACL 系统已实现，需验证细节行为

- [ ] **T8: 测试覆盖验证 - voice.test.ts / voice-routing.test.ts**
  - 语音包路由、跨 Edge 语音、VoiceTarget
  - Rust 语音路由已实现，需验证

- [ ] **T9: 测试覆盖验证 - ban-system.test.ts**
  - 封禁管理 RPC、IP 封禁、证书封禁
  - Rust 封禁管理已实现，需验证

- [ ] **T10: 测试覆盖验证 - blob-storage.test.ts**
  - Blob 存储、用户头像、频道描述
  - Rust Blob 存储已实现，需验证

- [ ] **T11: 测试覆盖验证 - user-state-broadcast.test.ts / user-info.test.ts / user-visibility.test.ts**
  - UserState 广播、用户信息查询、可见性规则
  - 需验证 Rust 实现的细节行为

- [ ] **T12: 测试覆盖验证 - moderation.test.ts**
  - Kick/Ban/Move 操作、管理员权限
  - 需验证 Rust 实现

- [ ] **T13: 测试覆盖验证 - udp-connection.test.ts / edge-voice-encryption.test.ts / tcp-voice.test.ts**
  - UDP 语音、OCB2 加密、TCP 回退
  - Rust OCB2 加密已实现，需验证端到端流程

- [ ] **T14: 测试覆盖验证 - preconnect-state.test.ts**
  - 认证前 UserState 设置
  - 需确认 Rust Edge 实现了 PreConnectUserState 处理

- [ ] **T15: 测试覆盖验证 - listening-channel.test.ts**
  - listening_channel_add/remove 处理
  - Rust Edge 已实现，需验证

- [ ] **T16: 测试覆盖验证 - plugin.test.ts**
  - PluginDataTransmission 路由
  - Rust 已实现，需验证

### P2 - 高级功能测试

- [ ] **T17: 测试覆盖验证 - edge-connection-user-sync.test.ts**
  - Edge 连接/断开时的用户状态同步
  - 跨 Edge 用户状态广播

- [ ] **T18: 测试覆盖验证 - edge-reconnect.test.ts**
  - Edge 断连重连后的状态恢复

- [ ] **T19: 测试覆盖验证 - hub-restart.test.ts**
  - Hub 重启后 Edge 重连
  - 需 `hubServer.stop()` / `hubServer.start()` 等效操作（Rust 进程重启）

- [ ] **T20: 测试覆盖验证 - channel-ninja.test.ts**
  - Channel Ninja 隐身模式
  - 需确认 Rust Edge 实现了 channel_ninja 逻辑

- [ ] **T21: 测试覆盖验证 - voice-target-permission.test.ts**
  - Whisper 权限检查

- [ ] **T22: 测试覆盖验证 - udp-routing-composite-key.test.ts / udp-quality-simulation.test.ts**
  - UDP 路由复合键、网络质量模拟

- [ ] **T23: 测试覆盖验证 - edge-external-port.test.ts**
  - Edge 外部端口配置
  - 需 Rust Edge 支持外部端口配置

### P3 - TS 特有测试（需特殊处理）

- [ ] **T24: multi-tenant-sni.test.ts 适配**
  - 此测试直接测试 TS 类（`VirtualHostManager`, `SecureContextManager`）
  - Rust 模式下：跳过或改为测试 SNI 网络行为（通过实际 TLS 连接验证）
  - Rust Edge 需实现 SNI 多租户支持（`virtual_hosts` 配置）

- [ ] **T25: worker-pool.test.ts 适配**
  - 此测试测试 TS Worker Thread Pool（`getCryptoWorkerPool()`）
  - Rust 使用 Tokio 原生并发，无需 Worker Pool
  - Rust 模式下：跳过 Worker Pool 特定测试，保留连接/语音测试部分

### P4 - 文档和最终验证

- [ ] **T26: 完整集成测试运行**
  - 设置 `MUNODE_USE_RUST=1`，编译 Rust，运行全部集成测试
  - 记录通过/失败状态，持续修复直到全部通过

- [ ] **T27: CI/CD 配置**
  - 在 GitHub Actions 中添加 Rust 集成测试工作流
  - 包含 Rust 构建缓存、测试数据库初始化、并行测试运行

---

## 当前阻塞问题

1. **HTTP 认证** - Rust Hub 缺少 HTTP auth URL 支持（T2）→ 已开始实现
2. **测试基础设施** - setup.ts 需要适配 Rust 进程模式（T1）→ 已开始实现
3. **Web API 端口** - 部分测试检查 `webApiPort`，但 Rust Hub 无此端口 → 需添加最小 HTTP API

## 参考文档

- [01-test-integration-design.md](01-test-integration-design.md) - 集成测试适配架构设计
- [archive/00-status-overview.md](archive/00-status-overview.md) - Rust 实现功能状态（历史文档）
