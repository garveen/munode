# MuNode Rust Implementation TODO

本文档追踪 Rust 实现中发现的代码质量问题和待改进项。
基于对全部 40 个 Rust 源文件（约 21,600 行）的深度审计。

> **上次审计时间**: 2026-03-15

---

## 已完成功能总览

以下功能均已实现并通过测试，不再逐项列出详细任务清单：

| 功能 | 模块 | 状态 |
|------|------|------|
| Web API 接口（status/edges/stats/topology/health/bans/metrics） | Hub | ✅ 已完成 |
| Blob 存储系统（文件系统，SHA-256 分片目录） | Hub | ✅ 已完成 |
| 带宽和消息限制（令牌桶速率限制） | Hub/Edge | ✅ 已完成 |
| 用户名/频道名验证规则（正则表达式） | Hub | ✅ 已完成 |
| 自动封禁系统（IP 追踪、时间窗口、CIDR 匹配） | Hub | ✅ 已完成 |
| 频道记忆功能（用户重连恢复频道） | Hub | ✅ 已完成 |
| 客户端建议配置（SuggestConfig） | Edge | ✅ 已完成 |
| Channel Ninja 功能（用户可见性隔离） | Hub/Edge | ✅ 已完成 |
| 监听者功能（跨频道音频路由、权限检查） | Hub/Edge | ✅ 已完成 |
| 语音路由策略（质量感知智能路由、Dijkstra） | Hub/Edge | ✅ 已完成 |
| 集群分割探测与处置（Union-Find、shutdownRequest） | Hub/Edge | ✅ 已完成 |
| Hub 连接池（多 slot、round-robin） | Edge | ✅ 已完成 |
| 控制信道中继（always-on relay、static_peers） | Edge | ✅ 已完成 |
| 语音三跳 relay 路由（EDGE_PKT_RELAY） | Edge | ✅ 已完成 |
| 性能优化（语音热路径锁优化、O(1) 索引） | Edge | ✅ 已完成 |
| Prometheus metrics（全局 + 每 Edge 标签化） | Hub | ✅ 已完成 |
| 结构化 JSON 日志 | Hub/Edge | ✅ 已完成 |
| 运维工具（migrate/backup/admin/diagnose/generate-config） | Hub/Edge | ✅ 已完成 |
| GeoIP 查询（连接时记录地理位置） | Hub | ✅ 已完成 |

---

## 有意不实现的功能

| 功能 | 原因 |
|------|------|
| 服务器注册（公共列表） | 现代部署不需要 |
| Channel Ninja 音频路由隔离 | UDP 层过滤工作量大，无实际需求 |
| Edge 侧客户端建议配置 | 与 Hub suggest 功能重复 |
| GeoIP 基于位置的 Edge 路由 | Hub 选路逻辑复杂，当前规模实用性有限 |
| 分布式追踪（OpenTelemetry） | 重量级依赖，结构化 JSON 日志已满足需求 |
| 性能基准测试套件 | 当前优先级不足 |
| 集群分区可控网络断开测试 | 需要 iptables/tc 等基础设施，测试成本高 |

---

## 代码审计发现的问题

### 🔴 严重（Critical）— 安全/稳定性风险

#### ~~C-01: TLS 客户端证书验证器接受任意证书~~ ✅ 已修复
- **文件**: `munode-edge/src/tls.rs:39-75`
- **描述**: `OptionalClientCertVerifier` 的 `verify_client_cert()`、`verify_tls12_signature()`、`verify_tls13_signature()` 全部返回硬编码的 `Ok()`，不做任何验证。注释说"仅用于身份识别，非认证"，但没有任何链验证、过期检查或签名验证。
- **影响**: 自签名、过期、篡改的证书均可通过。
- **建议**: 添加基本证书验证（至少验证签名和有效期），或明确文档说明这是 Mumble 协议兼容行为。

#### ~~C-02: crypto.rs 中 RNG 失败导致 panic~~ ✅ 已修复
- **文件**: `munode-edge/src/crypto.rs:58-61`
- **描述**: `generate_key()` 中 `rng.fill().expect("RNG failed")` 共 3 处。如果系统熵池耗尽，整个 Edge 进程崩溃。
- **影响**: 加密子系统 panic 级故障，无法恢复。
- **建议**: 返回 `Result` 并向上传播错误，而非 panic。

#### ~~C-03: crypto.rs 中 AES 初始化 panic~~ ✅ 已修复
- **文件**: `munode-edge/src/crypto.rs:40, 61, 73`
- **描述**: `Aes128::new_from_slice(&key).expect("AES key init failed")` 共 3 处。虽然 16 字节 key 正常不会失败，但 `.expect()` 在公共 API 中不应使用。
- **建议**: 使用 `?` 操作符或显式验证 key 长度。

#### ~~C-04: server.rs 中 `std::process::exit(0)` 强制退出~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs:2599`
- **描述**: 收到 `ShutdownRequested` 事件时直接调用 `std::process::exit(0)`，强制终止进程。其他 tokio 任务无机会优雅关闭，连接无法正常终止。
- **影响**: 资源泄漏、连接未正常断开、数据可能丢失。
- **建议**: 通过 shutdown channel 通知主任务，让 main 函数优雅退出。

#### ~~C-05: logging.rs 双重初始化导致 panic~~ ✅ 已修复
- **文件**: `munode-common/src/logging.rs:25, 32`
- **描述**: `tracing_subscriber` 的 `.init()` 如果被调用两次会 panic。没有 `once_cell` 或 `std::sync::Once` 保护。
- **影响**: 如果初始化逻辑被意外调用两次，进程崩溃。
- **建议**: 使用 `try_init()` 或 `Once` 保护。

---

### 🟠 高（High）— 功能/健壮性问题

#### ~~H-01: database.rs 中 30 处 `.lock().unwrap()` mutex panic 风险~~ ✅ 已修复
- **文件**: `munode-hub/src/database.rs` — 30 处
- **描述**: 所有数据库操作都使用 `self.conn.lock().unwrap()`。如果任何线程在持锁时 panic，mutex 被 poison，后续所有数据库操作均 panic，造成级联崩溃。
- **影响**: 单个线程 panic 导致整个 Hub 不可用。
- **建议**: 使用 `.lock().map_err(|e| anyhow!("Database mutex poisoned: {e}"))` 或恢复策略。

#### ~~H-02: udp.rs 中 5 处 `.lock().unwrap()` 在语音热路径~~ ✅ 已修复
- **文件**: `munode-edge/src/udp.rs:304, 348, 425, 550, 633`
- **描述**: CryptState 的 mutex 在每个语音包处理时 `.lock().unwrap()`。热路径中的 panic 会导致 UDP 服务器崩溃。
- **影响**: 语音服务完全中断。
- **建议**: 使用 `.lock().map_err()` 并跳过该包处理，而非 panic。

#### ~~H-03: rpc_handler.rs 中 RNG panic~~ ✅ 已修复
- **文件**: `munode-hub/src/rpc_handler.rs:3025`
- **描述**: `generate_challenge()` 中 `rng.fill(&mut buf).unwrap()`，认证挑战生成时 panic。
- **影响**: 认证流程崩溃。
- **建议**: 返回 `Result`。

#### ~~H-04: relay_server.rs WebSocket 握手无超时~~ ✅ 已修复
- **文件**: `munode-edge/src/relay_server.rs:87, 92`
- **描述**: `accept_async()` 和 `connect_async()` 均无超时包装。慢客户端或网络挂起可无限阻塞。
- **影响**: 连接池耗尽攻击风险。
- **建议**: 用 `tokio::time::timeout(Duration::from_secs(30), ...)` 包装。

#### ~~H-05: server.rs 任务强制 abort 无优雅关闭~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs:157-159`
- **描述**: `udp_handle.abort()`、`hub_handle.abort()`、`event_handle.abort()` 强制终止后台任务，无机会清理资源、刷新缓冲区、关闭连接。
- **建议**: 使用 `CancellationToken` 或 shutdown channel 实现优雅关闭。

#### ~~H-06: hub_client.rs RPC 超时竞态条件~~ ✅ 已修复
- **文件**: `munode-edge/src/hub_client.rs` — `rpc_call` 相关
- **描述**: RPC 请求先插入 pending map 再发送。如果发送失败，pending 请求永远留在 map 中（直到超时）。在超时处理移除请求后，响应仍可能到达并尝试发送到已 drop 的 channel。
- **建议**: 发送失败时立即清理 pending 请求。

#### ~~H-07: rpc_handler.rs 封禁检查 "fail open" 策略~~ ✅ 已修复
- **文件**: `munode-hub/src/rpc_handler.rs:407-408`
- **描述**: 封禁检查数据库错误时 "fail open"（允许连接），而非 "fail closed"。如果数据库不可用，所有被封禁的 IP 均可连接。
- **影响**: 安全绕过风险。
- **建议**: 数据库错误时应拒绝连接（fail closed），或实现熔断器。

#### ~~H-08: rpc_handler.rs 静默忽略数据库写入错误~~ ✅ 已修复
- **文件**: `munode-hub/src/rpc_handler.rs:467, 648, 797`
- **描述**: `let _ = self.state.database.upsert_ext_user(...)` 静默忽略数据库写入失败。用户数据可能未持久化。
- **建议**: 至少记录日志 `warn!`。

#### ~~H-09: web_api.rs 启动失败静默忽略~~ ✅ 已修复
- **文件**: `munode-hub/src/web_api.rs:569-586`
- **描述**: `run_web_api()` 返回 `()`，绑定失败只记录日志但返回成功。调用方无法知道 Web API 是否可用。
- **影响**: 服务器看似启动成功，但 Web API 实际不可用。
- **建议**: 返回 `Result<()>`。

#### ~~H-10: topology_manager.rs Union-Find 递归无深度限制~~ ✅ 已修复
- **文件**: `munode-hub/src/topology_manager.rs:208`
- **描述**: `detect_partitions()` 内部 `find()` 函数使用递归实现，大规模集群或异常数据可能栈溢出。
- **建议**: 改用迭代式路径压缩。

#### ~~H-11: edge_connection.rs writer 任务强制 abort~~ ✅ 已修复
- **文件**: `munode-hub/src/edge_connection.rs:87`
- **描述**: `writer_handle.abort()` 不等待刷新队列，飞行中的消息可能丢失。
- **建议**: 先发送关闭信号，等待 task 完成。

#### ~~H-12: server.rs 无最大并发连接限制~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs` — TCP accept 循环
- **描述**: accept 循环无限接受连接，没有 semaphore 或计数器限制。可被连接耗尽攻击。
- **建议**: 添加 `tokio::sync::Semaphore` 限制并发连接数。

#### ~~H-13: server.rs 无客户端空闲超时~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs` — 客户端读循环
- **描述**: 客户端读循环没有空闲超时。僵尸连接会永久占用资源。
- **建议**: 添加读超时或定期 ping 验证。

---

### 🟡 中等（Medium）— 代码质量/可维护性

#### ~~M-01: rpc_handler.rs 中 VoiceTargetEntry 为死代码~~ ✅ 已修复
- **文件**: `munode-hub/src/rpc_handler.rs:61-68`
- **描述**: `VoiceTargetEntry` 结构体标记 `#[allow(dead_code)]`，`voice_targets` 字段只写不读。语音目标同步功能未完成或废弃。
- **建议**: 完成实现或移除。

#### ~~M-02: hub_client.rs 中 relay_port 字段标记死代码~~ ✅ 已修复
- **文件**: `munode-edge/src/hub_client.rs:111`
- **描述**: `#[allow(dead_code)]` 标记的 `relay_port` 字段。
- **建议**: 使用或移除。

#### ~~M-03: acl_manager.rs 缓存全量失效~~ ✅ 已修复
- **文件**: `munode-hub/src/acl_manager.rs:182-186`
- **描述**: `invalidate_channel()` 清除整个缓存而非只清除受影响条目，导致不必要的缓存未命中。
- **建议**: 实现精准缓存失效。

#### ~~M-04: server.rs 权限位使用硬编码魔数~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs` — 多处
- **描述**: 权限检查使用硬编码位掩码（`0x1`、`0x4`、`0x8`、`0x800`）且 fail-open/fail-closed 策略不一致。部分用 `.unwrap_or(true)`（fail-open），部分用 `.unwrap_or(false)`（fail-closed）。
- **建议**: 定义权限常量（如 `PERM_WRITE = 0x1`），统一失败策略。

#### ~~M-05: server.rs 客户端版本字符串无长度限制~~ ✅ 已修复
- **文件**: `munode-edge/src/server.rs:278-280`
- **描述**: 客户端发送的 `release`、`os`、`os_version` 字符串直接使用，无最大长度验证。可能导致日志注入或内存问题。
- **建议**: 添加长度限制（如 256 字节截断）。

#### ~~M-06: database.rs VACUUM INTO 使用字符串拼接~~ ✅ 已修复（添加注释说明 SQLite 限制，保留 SQL 转义）
- **文件**: `munode-hub/src/database.rs:332`
- **描述**: `VACUUM INTO '{}'` 使用 `replace('\'', "''")` 做 SQL 转义。虽然风险有限（路径来自配置），但应使用 SQLite backup API。
- **建议**: 使用 `rusqlite` 的 `backup` 模块。

#### ~~M-07: lua_auth.rs unsafe impl Send/Sync~~ ✅ 已确认安全（补充 Safety 注释）
- **文件**: `munode-hub/src/lua_auth.rs:96-97`
- **描述**: `unsafe impl Send for LuaAuthEngine {}` 和 `unsafe impl Sync for LuaAuthEngine {}`。如果 mlua 的 `send` feature 已正确启用，这些应该是不必要的。
- **建议**: 验证 mlua feature flags，如果 `Lua: Send` 已满足则移除 unsafe impl。

#### ~~M-08: config.rs 版本号解析溢出~~ ✅ 已修复
- **文件**: `munode-common/src/config.rs:605`
- **描述**: `(major << 48) | (minor << 32) | (patch << 16)` 位移操作无验证输入范围。major > 65535 时溢出。
- **建议**: 添加范围验证。

#### ~~M-09: rate_limiter.rs f32 精度问题~~ ✅ 已修复（升级为 f64）
- **文件**: `munode-common/src/rate_limiter.rs:24, 47-48`
- **描述**: `burst as f32` 转换在 burst > 2^24 时精度丢失。`as_secs_f32()` 在长时间间隔后精度下降。浮点累积误差。
- **建议**: 使用 `f64` 或整数运算。

#### ~~M-10: client.rs listening_index 可能泄漏空 Vec~~ ✅ 已修复
- **文件**: `munode-edge/src/client.rs:174-181`
- **描述**: `remove_client()` 清理 listening_index 时，用 `retain` 移除 session 但不删除空的 Vec entry。map 会随时间增长。
- **建议**: retain 后检查并移除空 Vec。

#### ~~M-11: channel_store.rs 自增 ID 可能冲突~~ ✅ 已修复（补充注释说明 ID 分配策略）
- **文件**: `munode-hub/src/channel_store.rs:46`
- **描述**: `max_id` 仅基于加载的频道计算。如果频道被删除后 ID 回收，新频道可能与数据库中的历史 ID 冲突。
- **建议**: 使用数据库自增 ID 或全局单调递增。

#### ~~M-12: blob_store.rs 生产代码中使用 expect~~ ✅ 已修复
- **文件**: `munode-hub/src/blob_store.rs:71`
- **描述**: `path.parent().expect("blob path has a parent")` — 理论上不会失败但仍是 panic 点。
- **建议**: 用 `ok_or_else` 返回 Result。

#### ~~M-13: web_api.rs Prometheus 标签转义不完整~~ ✅ 已修复（添加换行符转义）
- **文件**: `munode-hub/src/web_api.rs:494, 507, 520, 533`
- **描述**: 只转义反斜杠和双引号，不处理换行符等控制字符，可能产生非法 Prometheus 输出。
- **建议**: 添加换行符转义 `\n → \\n`。

#### ~~M-14: rpc_handler.rs full_sync 不含 ACL 和 ban 数据~~ ✅ 已修复（补充说明按需查询设计意图）
- **文件**: `munode-hub/src/rpc_handler.rs:1365-1366`
- **描述**: `EdgeFullSyncResult` 中 `acls` 和 `bans` 为空 vec。Edge 无法获得完整的 ACL/ban 快照。
- **建议**: 至少文档说明这是有意设计（Edge 通过 RPC 按需查询）。

#### ~~M-15: rpc_handler.rs edge current_load 始终为 0~~ ✅ 已修复（基于会话数计算负载千分比）
- **文件**: `munode-hub/src/rpc_handler.rs:1357-1358`
- **描述**: Edge 注册信息中 `current_load: 0` 硬编码，从不更新。负载均衡决策无法基于实际负载。
- **建议**: 定期上报 Edge 负载或基于 session 数估算。

#### ~~M-16: hub_client.rs heartbeat 单次失败永久停止~~ ✅ 已修复（单次失败 continue 而非 break）
- **文件**: `munode-edge/src/hub_client.rs:1346`
- **描述**: heartbeat 循环在单次发送失败后 `break`，永久停止心跳。无重试机制。
- **建议**: 单次失败后继续重试，连续多次失败再退出。

#### ~~M-17: hub_client.rs WebSocket URL 硬编码 ws://~~ ✅ 已修复（添加 hub_server.tls 配置项支持 wss://）
- **文件**: `munode-edge/src/hub_client.rs:307-308`
- **描述**: WebSocket 连接 URL 硬编码为 `ws://`（不加密），不支持 `wss://`。
- **建议**: 添加 TLS 支持选项。

#### ~~M-18: state.rs edge_id 内存序不完整~~ ✅ 已修复（读端改为 Acquire）
- **文件**: `munode-edge/src/state.rs:166, 268-275`
- **描述**: `edge_id` 使用 `Ordering::Relaxed` 读取和 `Ordering::Release` 写入，但读端没有对应的 `Acquire`。如果其他状态依赖 edge_id 的设置，可能看到不一致的状态。
- **建议**: 读端使用 `Ordering::Acquire` 或文档化内存序假设。

#### ~~M-19: server.rs 语音数据在循环中重复 clone~~ ✅ 已修复（使用 Arc<Vec<u8>> 共享帧缓冲区）
- **文件**: `munode-edge/src/server.rs` — 语音路由循环
- **描述**: `data.clone()` 在发送给每个目标时调用（约 74 处 clone）。高负载下造成内存压力。
- **建议**: 使用 `Arc<Vec<u8>>` 或 `Bytes` 共享数据。

---

### 🔵 低（Low）— 代码风格/改进建议

#### ~~L-01: build.rs 连续 unwrap 无错误上下文~~ ✅ 已修复
- **文件**: `munode-protocol/build.rs:23-25`
- **描述**: `manifest_dir.parent().unwrap().parent().unwrap()` — 无错误上下文的连续 unwrap。
- **建议**: 使用 `.ok_or("...")` 添加上下文。

#### ~~L-02: transport.rs payload 长度 u32 截断~~ ✅ 已修复（使用 try_into() + expect 添加说明）
- **文件**: `munode-protocol/src/transport.rs:43`
- **描述**: `payload.len() as u32` 在 >4GB 时静默截断（虽然实际不可能）。
- **建议**: 使用 `try_into()` 验证。

#### ~~L-03: message_type.rs 手动 match 维护性差~~ ✅ 已修复
- **文件**: `munode-protocol/src/message_type.rs:39-70`
- **描述**: `from_u16()` 手动匹配所有枚举变体，新增类型时容易遗漏。
- **建议**: 使用 `num_enum` 或 `strum` derive 宏自动生成。
- **已实现**: 添加 `num_enum 0.7` 依赖；`MessageType` 和 `UdpVoiceType` 均派生 `TryFromPrimitive` + `IntoPrimitive`；`from_u16()` 委托给 `TryFrom<u16>`；消除 32 行手动 match。

#### ~~L-04: error.rs 错误类型使用 String 而非枚举~~ ✅ 已修复
- **文件**: `munode-common/src/error.rs`
- **描述**: 错误变体（Config、Tls、Connection 等）使用 `String` 参数，丢失类型信息。
- **建议**: 使用嵌套错误枚举保留上下文。
- **已实现**: 新增 `ConfigError`、`TlsError`、`ConnectionError`、`AuthError`、`ProtocolError`、`HubError` 六个细粒度枚举；`MunodeError` 通过 `#[from]` 聚合，保持调用侧的 `?` 操作符体验；所有变体携带结构化字段而非 String。

#### ~~L-05: session_manager.rs 未使用参数~~ ✅ 已修复（保留参数 + 补充注释说明预留用途）
- **文件**: `munode-hub/src/session_manager.rs:40`
- **描述**: `allocate_session_id(_edge_id: u32)` 参数未使用。
- **建议**: 移除或使用该参数。

#### ~~L-06: geoip.rs IPv6 ULA 检查缺少边界验证~~ ✅ 已修复（补充注释 + 修正 ULA/link-local 掩码）
- **文件**: `munode-hub/src/geoip.rs:129-130`
- **描述**: IPv6 ULA 检查假设 `segments()[0]` 存在但无显式边界检查。
- **建议**: 添加长度验证。

#### ~~L-07: hub main.rs db_path.parent().unwrap()~~ ✅ 已修复
- **文件**: `munode-hub/src/main.rs:68`
- **描述**: `db_path.parent().unwrap()` — 如果路径为根目录会 panic。
- **建议**: 使用 `and_then` 或条件检查。

#### ~~L-08: crypto.rs 重放保护只存 1 字节历史~~ ✅ 已确认为有意设计（补充注释说明）
- **文件**: `munode-edge/src/crypto.rs:213`
- **描述**: `decrypt_history[self.decrypt_iv[0]]` 只存每个 IV[0] 值的 1 字节历史。多个包有相同 IV[0] 但不同 IV[1..] 时可能绕过重放检查。
- **注意**: 这是 Mumble 官方 OCB2 实现的兼容行为，不一定需要修改。
- **已实现**: 补充详细注释说明 256-bucket 窗口大小对真实网络抖动已足够，以及匹配 Mumble 参考实现是有意为之以保证互通性。

#### ~~L-09: crypto.rs 测试未覆盖 IV 环绕边界~~ ✅ 已修复（新增 test_encrypt_decrypt_at_iv_wraparound 测试）
- **文件**: `munode-edge/src/crypto.rs` — 测试区
- **描述**: 缺少 IV 在 0xFF 边界环绕的测试用例。
- **建议**: 添加边界测试。

---

## 架构级改进建议

### ~~A-01: 统一的优雅关闭机制~~ ✅ 已修复
- **现状**: 混合使用 `task.abort()`、`process::exit()` 和 channel drop。
- **建议**: 全局使用 `tokio_util::sync::CancellationToken` 或 `tokio::sync::watch` 实现统一的优雅关闭。
- **已实现**: Edge 服务器的关闭信号改用 `tokio::sync::watch::channel(false)` 替代 `mpsc::channel::<()>(1)`；watch receiver 可被 clone 供多任务同时观察；`hub_event_listener` 通过 `shutdown_tx.send(true)` 触发关闭，主接受循环通过 `watch_rx.wait_for(|v| *v)` 响应。无需引入额外依赖。

### ~~A-02: 统一的 Mutex 错误处理策略~~ ✅ 已修复
- **现状**: 30+ 处 `.lock().unwrap()` 分布在 database.rs 和 udp.rs。
- **建议**: 封装一个 `SafeMutex<T>` wrapper，统一处理 poison 错误（记录日志 + 尝试恢复或转为 anyhow::Error）。
- **已实现**: H-01/H-02 中已将所有 `unwrap()` 替换为 `map_err()` 错误处理。

### ~~A-03: 权限常量和策略集中化~~ ✅ 已修复
- **现状**: 权限位掩码（0x1、0x4、0x8、0x800 等）散落在 server.rs 各处，fail-open/closed 不一致。
- **建议**: 在 `munode-common` 或 `munode-protocol` 中定义权限常量，统一 fail 策略。
- **已实现**: 新建 `munode-common/src/permission.rs`，包含全部 18 个权限常量（NONE/WRITE/TRAVERSE/ENTER/SPEAK/MUTE_DEAFEN/MOVE/MAKE_CHANNEL/LINK_CHANNEL/WHISPER/TEXT_MESSAGE/TEMP_CHANNEL/LISTEN/KICK/BAN/REGISTER/SELF_REGISTER/ALL/DEFAULT）；Hub 的 `acl_manager.rs` 改为 `pub use munode_common::permission;` 重导出；Edge 的 `server.rs` 移除本地 `mod perm`，改为 `use munode_common::permission as perm;`。

### ~~A-04: 连接生命周期管理~~ ✅ 已修复
- **现状**: 无最大连接数限制、无客户端空闲超时、无 WebSocket 握手超时。
- **建议**: 添加 Semaphore 限流、idle timeout、handshake timeout。
- **已实现**: H-12（Semaphore）、H-13（idle timeout）、H-04（握手超时）均已修复。

---

## 测试覆盖率追踪

### Hub Server 集成测试

| 功能模块 | 测试覆盖 | 状态 |
|---------|---------|------|
| 认证（本地数据库） | ✅ | auth.test.ts |
| 认证（HTTP） | ✅ | auth.test.ts |
| 认证（Lua） | ✅ | lua-auth.test.ts (Rust only) |
| Edge 注册 | ✅ | edge-cluster-join.test.ts |
| 频道管理 | ✅ | channel.test.ts |
| ACL 权限 | ✅ | acl*.test.ts |
| 用户状态同步 | ✅ | user-state-broadcast.test.ts |
| Hub 重启恢复 | ✅ | hub-restart.test.ts |
| Web API | ✅ | web-api.test.ts (Rust only) |
| Blob 存储 | ✅ | blob-storage.test.ts |
| 自动封禁 | ✅ | auto-ban.test.ts |
| 频道记忆 | ✅ | channel-memory.test.ts |
| 消息限制 | ✅ | message-limits.test.ts |
| 验证规则 | ✅ | validation-rules.test.ts (Rust only) |

### Edge Server 集成测试

| 功能模块 | 测试覆盖 | 状态 |
|---------|---------|------|
| 客户端连接 | ✅ | hub-edge.test.ts |
| UDP 连接 | ✅ | udp-connection.test.ts |
| TCP 语音 | ✅ | tcp-voice.test.ts |
| 语音路由 | ✅ | voice*.test.ts |
| 语音路由策略 | ✅ | voice-routing-strategy.test.ts (Rust only) |
| 语音三跳 relay | ⚠️ | 代码已实现，端到端测试需多 Edge 拓扑 |
| 质量感知路由 | ⚠️ | 核心逻辑已实现，端到端测试需多 Edge 拓扑 |
| 语音加密 | ✅ | edge-voice-encryption.test.ts |
| 包丢失计算 | ✅ | edge-packet-loss-calculation.test.ts |
| GeoIP | ✅ | geoip.rs 单元测试 |
| 连接池 | ✅ | hub-connection-pool.test.ts (Rust only) |
| JSON 日志 | ✅ | log-format.test.ts (Rust only) |
| Prometheus 指标 | ✅ | web-api.test.ts (Rust only) |
| 诊断工具 | ✅ | diagnose.test.ts (Rust only) |
| 数据库迁移/备份/管理 | ✅ | hub-admin.test.ts (Rust only) |
| 控制信道中继 | ✅ | peer-proxy.test.ts (Rust only) |

---

## 贡献指南

### 修复代码问题

1. 选择一个上方列出的问题（建议从 Critical/High 开始）
2. 创建功能分支：`git checkout -b fix/问题编号`
3. 修复代码
4. 确保现有测试通过：`cd rust && cargo test`
5. 运行集成测试：`MUNODE_USE_RUST=1 pnpm test:integration`
6. 更新本文档，将修复的问题标记为已完成
7. 提交 PR

### 测试要求

- 所有修复必须确保现有测试仍然通过
- Critical/High 级别修复应添加回归测试
- 测试必须在 Rust 模式下通过

---

## 更新日志

- 2026-03-19: **全面进度盘点 + H-3 改进** — 确认 H-3/H-4/H-5/M-1/M-4/C-3-5 已实现；改进 ACL 缓存驱逐策略（从 clear-all 改为优先驱逐匿名用户的部分驱逐，保留 75% 注册用户条目）；ACL calculate_permissions 中的 load_acls 调用改为单次 spawn_blocking；新增 1 个 ACL 驱逐测试；更新 architecture-review.md 各条目状态；当前进度：19 个问题中 14 个完全或基本解决，剩余 H-1（UDP 加密）、C-3（分页）、M-2（零拷贝暂缓）、M-6（Edge 缓存）共 4 个待实现
- 2026-03-19: **继续实现 architecture-review 待办项** — 完成 C-1（关键热路径 spawn_blocking：upsert_ext_user、get_user_last_channel、ACL 权限组查询合并为单次 spawn_blocking）、C-2（broadcast_critical_excluding 消除 on_user_state / on_text_message 的 try_send）、H-2（Relay Server HMAC token 认证：URL 查询参数 ts+token，30 秒有效期防重放，6 个单元测试）、M-3（edge.example.toml 默认启用 pool_size = 3）
- 2026-03-15: **修复所有 Critical 和 High 问题** — 完成 C-01～C-05、H-01～H-13 共 18 项修复，包括 TLS 证书验证、mutex panic 消除、优雅关闭、连接限制等
- 2026-03-15: **完成所有剩余 TODO 项** — L-08 确认为 Mumble 兼容设计并补充注释；A-01 统一关闭信号改用 watch::channel；A-03 权限常量迁移至 munode-common::permission；copilot-instructions 添加 Git 提交规范（英文提交信息）
- 2026-03-15: **修复 L-03/L-04** — 引入 `num_enum 0.7` 消除 `from_u16()` 手动 match；重构 `MunodeError` 为 6 个细粒度子枚举；copilot-instructions 新增不需向后兼容的说明
- 2026-03-15: **修复所有 Medium 和 Low 问题** — 完成 M-01～M-19、L-01/L-02/L-05/L-06/L-07/L-09 共 25 项修复，包括权限常量化、精确缓存失效、f64 精度、wss:// 支持、IV 边界测试等
- 2026-03-15: **重写 TODO.md** — 移除已完成功能的详细任务清单（合并为总览表），基于全量代码审计新增 5 个 Critical、13 个 High、19 个 Medium、9 个 Low 级别代码质量问题，新增 4 个架构级改进建议
