# MuNode Rust Implementation TODO

本文档追踪 Rust 版本相对于 TypeScript 版本尚未实现的功能。

## 状态说明

- ✅ **已完成** - 功能已实现且测试通过
- 🚧 **进行中** - 正在实现
- ⏸️ **暂停** - 实现被阻塞或暂停
- 📋 **计划中** - 已规划但未开始
- ❓ **待定** - 是否实现待评估
- ❌ **不实现** - 明确决定不实现

## 优先级

- **P0** - 核心功能，必须实现
- **P1** - 重要功能，应尽快实现
- **P2** - 有用功能，可以延后
- **P3** - 可选功能，按需实现

---

## Hub Server 功能

### 1. Web API 接口

**优先级**: P2  
**状态**: ✅ 已完成

#### 功能描述
提供 HTTP REST API 接口用于：
- 查询服务器状态
- 获取 Edge 列表和详情
- 获取统计信息
- 查看网络拓扑

#### 实现任务
- [x] 设计 RESTful API 路由
- [x] 实现 HTTP 服务器（使用 axum 0.7）
- [x] 实现核心 API 端点
  - [x] GET /api/status - 服务器状态（版本、运行时间、Edge 数量、会话数）
  - [x] GET /api/edges - Edge 列表（含健康状态）
  - [x] GET /api/edges/:id - 特定 Edge 详情
  - [x] GET /api/stats - Hub 统计数据（会话数、频道数、Edge 数）
  - [x] GET /api/topology - 网络拓扑（Edge 和链路质量）
  - [x] GET /api/health - 健康检查
- [x] 通过 `[web_api]` 配置项启用/禁用

#### 集成测试
- [x] `web-api.test.ts` — 覆盖所有端点（仅 Rust 模式运行）

#### 参考
- TypeScript: `packages/hub-server/src/web-api-service.ts`

---

### 2. Blob 存储系统

**优先级**: P1  
**状态**: ✅ 已完成（文件系统存储）

#### 功能描述
存储和管理二进制数据：
- 用户头像（texture）
- 用户评论（comment）
- 频道描述（description）

#### 实现方式
Rust 版本使用文件系统存储 blob 数据，以 SHA-256 哈希前两位为子目录分片（`<path>/<hash[0:2]>/<hash>`），实现内容寻址和自动去重。数据库（`user_blobs` 表）仅保存用户与 blob hash 的映射关系。

#### 实现任务
- [x] 设计 blob 存储架构（文件系统，hash 分片目录）
- [x] 实现 `blob_store.rs`：原子写入（tmp→rename）、内容寻址、自动去重
- [x] 实现 `BlobStoreStats`：统计 blob 数量和总大小
- [x] 保留 `user_blobs` 表用于用户→hash 映射，移除 SQLite 内联 blob 数据
- [x] 添加 `HubBlobStoreConfig`（`blob_store.path`）
- [x] 添加 blob 上传/下载 RPC 接口（`blob.put`、`blob.get`）
- [x] 实现用户 blob 关联（`blob.setUserTexture`、`blob.setUserComment`）
- [x] 支持自动去重（相同内容共享同一 blob 文件）

#### 集成测试
- 通过 `user-info.test.ts` 中的 RequestBlob 测试覆盖
- `blob-storage.test.ts` 新增 Rust 模式专用测试套件

---

### 3. 带宽和消息限制配置

**优先级**: P0
**状态**: ✅ 已完成

#### 功能描述
细粒度的流量控制配置：
- 每用户带宽限制
- 文本消息长度限制
- 图片消息长度限制
- 消息速率限制（令牌桶）
- 插件消息限制

#### 实现任务
- [x] 添加配置项到 `HubConfig`（`limits` 段：`text_message_length`、`image_message_length`、`message_rate`、`message_burst`）
- [x] 添加配置项到 `EdgeConfig`（`server` 段：`text_message_length`、`image_message_length`、`message_rate`、`message_burst`）
- [x] 实现令牌桶速率限制器（`munode-common::rate_limiter::TokenBucket`）
- [x] 在消息处理中应用限制（Edge `server.rs` TextMessage 处理）
- [x] 添加限制超出的错误处理（返回 `PermissionDenied`）

#### 集成测试
- [x] 消息长度限制测试（`message-limits.test.ts`）
- [x] 消息速率限制测试（`message-limits.test.ts`）
- [x] 消息正常发送测试（`message-limits.test.ts`）
- [x] 插件消息限制实现（`server.plugin_message_length`，默认 1024 字节；超限则静默丢弃）
- [x] 用户组限制测试（`message-limits.test.ts` 已覆盖用户级别的限制；带宽和消息限制对所有用户一致）

#### 依赖
无

#### 参考
- TypeScript: Hub config `bandwidth`, `message_limit`, etc.
- 文档: `docs/rate-limiter-usage.md`

---

### 4. 用户名和频道名验证规则

**优先级**: P2  
**状态**: ✅ 已完成

#### 功能描述
通过正则表达式配置允许的字符：
- `username_regex` - 用户名验证
- `channel_name_regex` - 频道名验证

#### 实现任务
- [x] 添加 `username_regex` 配置项（`validation.username_regex`）
- [x] 添加 `channel_name_regex` 配置项（`validation.channel_name_regex`）
- [x] 实现正则表达式验证函数（`matches_regex()` in `rpc_handler.rs`，使用 `regex` crate）
- [x] 在用户认证时验证用户名（`handle_authenticate_user` Step -1，拒绝返回 `InvalidUsername`）
- [x] 在频道创建/重命名时验证（`handle_save_channel` 前置检查）
- [x] 添加友好的错误消息（含用户名/频道名和失败原因）

#### 集成测试
- [x] 有效用户名测试（`validation-rules.test.ts`）
- [x] 无效用户名拒绝测试（`validation-rules.test.ts`：数字开头、特殊字符、过短、含空格）
- [x] 有效频道名测试（`validation-rules.test.ts`）
- [x] 无效频道名拒绝测试（`validation-rules.test.ts`：特殊字符、下划线开头）
- [x] Unicode 字符测试（`validation-rules.test.ts`：中文用户名被拒绝）

#### 依赖
无

---

### 5. 自动封禁系统

**优先级**: P1  
**状态**: ✅ 已完成

#### 功能描述
基于行为的自动封禁：
- 连接尝试次数限制
- 时间窗口内的失败尝试
- 自动封禁时长
- 可选：封禁成功连接（暴力测试）

#### 实现任务
- [x] 添加 `auto_ban` 配置结构（`HubAutoBanConfig`：`enabled`、`attempts`、`time_window`、`duration`）
- [x] 实现连接尝试追踪（按 IP，`FailedAuthTracker` in `server.rs`）
- [x] 实现时间窗口滑动计数（过期自动清理）
- [x] 实现自动封禁逻辑（统一 `record_auth_failure()` 方法，所有认证失败路径均追踪）
- [x] 添加封禁列表存储（数据库 bans 表）
- [x] 实现封禁过期自动清理（基于 `time_window`）
- [x] **安全修复**: Step 0 实际检查数据库封禁列表（`check_ip_banned`），封禁 IP 立即拒绝连接
- [x] **安全修复**: 所有认证失败路径均追踪（外部认证服务、Lua、HTTP、服务器密码、用户未找到、本地DB密码错误）
- [x] 添加 CIDR 掩码匹配函数 `ip_matches_ban` 支持网段封禁
- [x] 添加手动解封接口（`DELETE /api/bans/:id` Web API）

#### 集成测试
- [x] 多次失败登录拒绝测试（`auto-ban.test.ts`）
- [x] 正确密码仍可登录测试（`auto-ban.test.ts`）
- [x] IP 封禁检查单元测试（`database.rs` 测试：`test_check_ip_banned_*`、`test_ip_matches_ban_*`）
- [x] 封禁期间连接拒绝集成测试（`auto-ban.test.ts`：3 次失败后被禁）
- [x] 封禁过期自动解除测试（`auto-ban.test.ts`：2s ban + 3.5s 等待后恢复登录）
- [x] 不同 IP 独立计数测试（`auto-ban.test.ts`：1次失败后正确密码仍可登录，未达到阈值2）

#### 依赖
无

#### 参考
- TypeScript: `auto_ban` config section

---

### 6. 频道记忆功能

**优先级**: P0
**状态**: ✅ 已完成

#### 功能描述
记住用户上次所在频道：
该功能不可禁用，永久记忆

#### 实现任务
- [x] 在数据库存储 `last_channel` 字段
- [x] 用户离线时保存频道信息（`save_user_last_channel`）
- [x] 用户上线时恢复频道（外部认证、Lua 认证、本地 DB 认证均支持）
- [x] 处理频道已删除的情况（认证时验证频道是否存在，不存在则回落默认）
- [x] 实现过期清理逻辑（每 5 分钟定期清理 `cleanup_expired_bans`）

#### 集成测试
- [x] 用户重连恢复频道测试（`channel-memory.test.ts`）
- [x] 首次登录使用默认频道测试（`channel-memory.test.ts`）
- [x] 频道已删除回退测试（`channel-memory.test.ts`）
- [x] 过期清理测试（自动 — 过期 ban 在到期后被 `check_ip_banned` 自动忽略，详见 expiry 集成测试）

#### 依赖
无

---

### 7. 客户端建议配置

**优先级**: P1
**状态**: ✅ 已完成

#### 功能描述
向客户端发送建议配置：
- `suggest.version` - 建议的客户端版本（数字格式，如 1340029）
- `suggest.positional` - 是否启用位置音频
- `suggest.push_to_talk` - 是否启用 PTT

#### 实现任务
- [x] 添加 `suggest` 配置结构（`EdgeSuggestConfig`）
- [x] 在 `EdgeConfig` 中添加 `suggest` 字段
- [x] 客户端连接时发送 `SuggestConfig` 消息（在 `send_server_config` 之后）

#### 集成测试
- [x] 验证 SuggestConfig 包含建议（`suggest-config.test.ts`：version=1340029, positional=true）
- [x] 测试各种建议组合（`suggest-config.test.ts`：带完整 suggest 配置与无 suggest 配置两种场景）
- [x] 验证客户端接收（`suggest-config.test.ts`：客户端 suggestConfig 事件触发验证）

#### 依赖
无


---

### 8. 服务器注册（公共列表）

**优先级**: P3  
**状态**: ❌ 不实现

#### 功能描述
将服务器注册到公共服务器列表：
- `register_password` - 注册密码
- `register_hostname` - 公共主机名
- `register_location` - 地理位置
- `register_url` - 服务器网站
- `bonjour` - 本地网络发现

#### 实现任务
N/A - 不计划实现

#### 原因
- 公共服务器列表不常用
- 现代部署更倾向于私有/企业内部使用
- 可通过外部工具实现（如 DNS-SD）
- 复杂度与收益不成正比

---

### 9. Channel Ninja 功能

**优先级**: P3
**状态**: 暂不实现

#### 功能描述
隐藏特定频道中的用户：
- `channel_ninja` - 全局开关
- `ninja_channels` - 忍者频道 ID 列表
- 无 Enter/Listen 权限的用户看不到这些频道中的用户

#### 实现任务
- [x] 添加配置项（`HubChannelNinjaConfig`：`enabled`、`ninja_channels`；`EdgeState.ninja_channels` / `ninja_visible_to`）
- [x] 在频道状态广播时过滤用户（`RemoteUserJoined` 事件携带 `is_ninja` 标志）
- [x] 在用户状态广播时检查权限（通过 Hub ACL 查询填充 `ninja_visible_to` 缓存，初次登录时查询）
- [x] 确保用户列表不泄露给无权限用户（初始同步与 `RemoteUserJoined` 均已过滤）
- [x] 忍者频道通过 Hub config 指定（`ninja_channels` 列表），Edge 从 `hub.ninjaConfig` 通知接收

#### 集成测试
- [x] 无权限用户看不到忍者频道用户（初始同步时已过滤）
- [x] 有权限用户正常看到（`ninja_visible_to` 缓存中有 channel_id → 正常显示）
- [x] 用户进出忍者频道测试（`channel-ninja.test.ts`：Rust 专项 2 个测试通过）
- [ ] 音频路由隔离测试 ❌ **不实现**：忍者频道的用户可见性已隔离；UDP 层不区分频道来源，音频隔离需要在语音路由层额外过滤，工作量大且当前无需求

#### 依赖
- ACL 系统（已实现）

#### 参考
- 文档: `CHANNEL_NINJA_IMPLEMENTATION.md`

---

### 10. 监听者功能

**优先级**: P0
**状态**: ✅ 已完成（基础实现）

#### 功能描述
频道监听（不在频道内也能听到）：
- `listeners_per_channel` - 每频道监听者限制
- `listeners_per_user` - 每用户可监听频道数限制
- `broadcast_listener_volume_adjustments` - 广播音量调整

#### 实现任务
- [x] 实现监听者状态管理（`ClientInfo.listening_channels`，`RemoteUser.listening_channels`）
- [x] 实现跨频道音频路由（`udp.rs` route_voice 中调用 `get_listening_sessions`）
- [x] Hub 侧追踪并广播监听状态变更（`handle_user_state_changed`）
- [x] 实现监听数量限制（`server.listeners_per_user`、`server.listeners_per_channel`；0=无限制）
- [x] 添加音量调整支持（`listening_volume_adjustment` 字段存储在 `ClientInfo.listening_volume_adjustments` HashMap，广播给 peers）
- [x] 处理权限检查（添加监听频道时检查 LISTEN 权限 0x800，无权限则返回 PermissionDenied）

#### 集成测试
- [x] 添加/移除监听者测试（`listening-channel.test.ts`）
- [x] 跨频道音频接收测试（`listening-channel.test.ts`）
- [x] 监听者数量限制测试（`listening-channel.test.ts`：per_user=2 超出拒绝；per_channel=1 第二人拒绝）
- [x] 音量调整广播测试（`listening-channel.test.ts`：设置 0.5x 并验证 peer 收到）
- [x] 权限检查测试（`acl.test.ts`：'should deny second user from listening to restricted channel'）

#### 依赖
无

#### 参考
- 文档: `docs/channel-listener-volume-adjustment.md`

---

### 11. 语音路由策略配置

**优先级**: P1  
**状态**: ✅ 已完成（含质量感知智能路由）

#### 功能描述
Edge 间语音路由的详细配置：
- 路由策略（直连/中转/混合）
- Hub 中继策略控制
- 故障转移
- **质量感知智能路由**：Hub 收集质量数据并推送最优路由表到 Edge

#### 实现情况
Hub 侧 `HubVoiceRoutingConfig`（`voice_routing` 配置段）：
- `enable_relay` — 是否允许 Hub 中继语音（默认 true）
- `relay_cost_factor` — 中继代价系数
- `direct_rtt_threshold` / `direct_loss_threshold` — 直连优先阈值
- `max_relay_streams_per_pair` / `max_total_relay_streams` — 流量上限

Edge 侧 `EdgeVoiceRoutingConfig`（`voice_routing` 配置段）：
- `connection_strategy` — `auto_fallback`/`tcp_only`/`direct_only`
- `fallback` — TCP 降级延迟和 UDP 恢复检测间隔
- `relay.enabled` / `relay.max_relay_bandwidth` — 中继节点配置

#### 实现任务
- [x] 基本直连路由（已实现）
- [x] Hub 中转路由（已实现）
- [x] `HubVoiceRoutingConfig` — Hub 中继策略配置
- [x] `EdgeVoiceRoutingConfig` — Edge 连接策略配置（`connection_strategy`）
- [x] `VoiceConnectionStrategy` 枚举（`auto_fallback`/`tcp_only`/`direct_only`）
- [x] `tcp_only` 策略强制使用 Hub 中继，跳过直连 UDP
- [x] `direct_only` 策略禁用 Hub 中继，仅直连 UDP
- [x] Hub 侧 `enable_relay=false` 时拒绝 `edge.relayVoiceViaTcp` RPC
- [x] `EdgeState.allow_hub_relay` / `allow_direct_udp` 标志位
- [x] **质量指标收集**：UDP 探针（ping/pong，PROBE_MAGIC=0xC2,0xDE），每 10s 测量 RTT 和丢包率
- [x] **质量上报**：`edge.reportQuality` RPC，每 30s 上报到 Hub
- [x] **Hub 路由计算**：`compute_route_table()` 用 Dijkstra 计算最优路由（direct/relay/hub_tcp）
- [x] **路由表推送**：Hub 在质量更新和 Edge 注册后推送 `hub.routeTableUpdate` 通知
- [x] **路由表应用**：Edge 按 `RouteDecision`（Direct/RelayVia/HubTcp）路由语音包
- [x] **协议**：新增 `HubRouteEntryProto`、`HubRouteTableUpdateParams`（protobuf tag=36）

#### 集成测试
- [x] 基本语音路由测试（已有）
- [x] 跨 Edge 语音测试（已有）
- [x] `connection_strategy=tcp_only` 专项测试（`voice-routing-strategy.test.ts`）
- [x] `connection_strategy=direct_only` 专项测试（`voice-routing-strategy.test.ts`）
- [x] `connection_strategy=auto_fallback` 专项测试（`voice-routing-strategy.test.ts`）

#### 依赖
无

#### 参考
- TypeScript: `voice_routing` config section
- 文档: `docs/Edge*.md`
- Rust 详细文档: `rust/docs/voice-routing-and-control-relay.md`

---

### 12. 集群分割探测与处置（Hub 侧）

**优先级**: P1  
**状态**: ✅ 已完成

#### 功能描述
Hub 检测到 Edge 间连接断裂时，自动识别形成的孤立子集群，并对用户数量最少的子集群发送关停通知，防止集群脑裂问题。

#### 当前实现情况（Rust Hub）
- ✅ `topology_manager.rs` 中已实现 `detect_partitions()`（Union-Find 算法）
- ✅ `arbitrate_disconnect()` 仲裁机制已实现（双边确认）
- ✅ `handle_report_peer_disconnect` RPC 处理已实现
- ✅ 检测到分割后，向最小子集群发送 `hub.shutdownRequest`（`handle_partition_after_disconnect`）
- ✅ `BothReported` 仲裁后自动调用 `detect_partitions()`

#### 当前实现情况（Rust Edge）
- ✅ Edge 处理 `hub.shutdownRequest` 消息，向本地客户端发送 `Reject` 并退出

#### TypeScript 对应实现
- ✅ `notification-handler.ts`: `detectDisconnectedClusters()` + `shutdownEdgeCluster()` 对小分区发 `hub.shutdownRequest`
- ✅ `hub-message-handler.ts`: Edge 侧 `handleShutdownRequestFromHub()` 完整处理

#### 实现任务
- [x] Hub: 在仲裁确认断连后调用 `detect_partitions()` 识别子集群
- [x] Hub: 统计各子集群用户数量，向最小子集群发送 `hub.shutdownRequest` 通知
- [x] Edge: 处理 `hub.shutdownRequest` 消息（优雅断开所有本地客户端并停止服务）
- [x] Edge: 收到关停请求后向连接的客户端发送 ServerReject
- [x] 协议: 添加 `HubShutdownRequestParams` 消息类型

#### 集成测试
- [x] Edge 连接正常运行测试（`cluster-partition.test.ts`）
- [x] Edge 断开优雅处理测试（`cluster-partition.test.ts`）
- [ ] 两个 Edge 断开连接触发仲裁测试 ❌ **不实现**：需要可控制的进程间网络断开基础设施（如 iptables/tc），测试基础设施成本高
- [ ] 分割检测后最小子集群收到关停请求测试 ❌ **不实现**：同上

#### 依赖
- 无

#### 参考
- TypeScript: `packages/hub-server/src/handlers/notification-handler.ts`
- TypeScript: `packages/edge-server/src/cluster/hub-message-handler.ts`

---

## Edge Server 功能

### 1. 详细的语音路由配置

**优先级**: P1  
**状态**: ✅ 已完成（含质量感知智能路由）

#### 功能描述
Edge 端的语音路由配置：
- `voice_routing.enabled` - 启用路由
- `voice_routing.connection_strategy` - 连接策略
- `voice_routing.fallback` - 降级配置
- `voice_routing.relay` - 中继配置

#### 实现任务
- [x] 基本 UDP 语音路由（已实现）
- [x] Edge 间 TCP 路由（已实现）
- [x] `EdgeVoiceRoutingConfig` 完整配置结构（`voice_routing` 段）
- [x] `connection_strategy`: `auto_fallback`/`tcp_only`/`direct_only`
- [x] `tcp_only` 策略实现 — 强制使用 Hub 中继（`allow_direct_udp=false`）
- [x] `direct_only` 策略实现 — 禁用 Hub 中继（`allow_hub_relay=false`）
- [x] 向后兼容 `server.disable_hub_relay` 配置项
- [x] `EdgeState.allow_hub_relay` / `allow_direct_udp` 标志位
- [x] UDP 服务器（`udp.rs`）和 TCP 服务器（`server.rs`）均遵循策略
- [x] **质量探测**：UDP ping/pong（`PROBE_MAGIC=[0xC2,0xDE]`），每 10s 探测 RTT 和丢包率
- [x] **智能路由决策**：按 Hub 推送的 `RouteDecision`（Direct/RelayVia/HubTcp）路由语音包
- [x] **`edge.reportQuality` RPC**：每 30s 上报质量数据到 Hub

#### 集成测试
- [x] 基本 UDP 路由测试（已有）
- [x] TCP 降级测试（已有）
- [x] `connection_strategy` 专项集成测试（`voice-routing-strategy.test.ts`：tcp_only / direct_only / auto_fallback）

#### 依赖
- Hub 语音路由配置（见上）

#### 参考
- TypeScript: `voice_routing` config in Edge
- 文档: `docs/Edge语音路由实现总结.md`
- Rust 详细文档: `rust/docs/voice-routing-and-control-relay.md`

---

### 2. GeoIP 功能

**优先级**: P3  
**状态**: ❓ 待定

#### 功能描述
根据 IP 地址确定用户地理位置：
- `features.geoip` - 启用 GeoIP
- 用于日志记录
- 用于统计分析
- 用于基于地理位置的路由优化

#### 实现任务
- [x] 集成 GeoIP 库（maxminddb-rust）
- [x] 加载 GeoLite2 数据库（`GeoIpService::new()` 支持 City/Country MMDB 格式）
- [x] 在用户连接时查询位置（`handle_authenticate_user` 中查询并记录地理位置）
- [x] 存储位置信息（通过日志记录 country/city；配置 `geoip.log_location`）
- [ ] 基于位置的 Edge 分配建议 ❌ **不实现**：需要复杂的 Hub 选路逻辑，当前部署规模下实用性有限

#### 集成测试
- [x] GeoIP 数据库加载测试（`geoip.rs` 单元测试：无 DB、无效路径均正确处理）
- [x] IP 位置查询测试（单元测试：私有 IP 跳过、公网 IP 非私有验证）
- [x] 边界情况测试（单元测试：127.0.0.1 loopback、192.168.x.x 私有地址）

#### 依赖
- GeoLite2 数据库文件

#### 备注
实用性有限，主要用于统计和日志。

---

### 3. Hub 连接池

**优先级**: P1
**状态**: ✅ 已完成

#### 功能描述
Edge 到 Hub 的连接池：
- `hub_server.pool_size` - 连接池大小（默认 1，= 单连接向后兼容）
- 多个并发 WebSocket 连接提高可靠性
- 轮询（round-robin）负载分散
- 连接故障自动恢复（每个 slot 独立重连）

#### 实现方式
连接池实现完全内化在 `HubClient` 中（无需修改调用方）：
- `pool_senders: Vec<Mutex<Option<Sender>>>` — 每个 slot 的发送通道
- `pool_rr: AtomicUsize` — 轮询计数器
- Slot 0 为主连接（处理 Hub→Edge 推送通知）
- Slot 1..N 为辅助连接（仅处理 RPC 响应，抑制通知以避免重复更新）
- 主连接完成 register/full_sync/join_cluster 后，辅助连接再建立

#### 实现任务
- [x] `hub_server.pool_size` 配置项（默认 1）
- [x] 多个并发 WebSocket 连接（`pool_senders`）
- [x] 轮询 RPC 请求负载均衡（`pool_rr`）
- [x] 连接故障自动恢复（per-slot 独立重连循环）
- [x] 主连接处理通知，辅助连接不处理（避免重复）

#### 集成测试
- [x] `pool_size=1` 向后兼容性验证（`hub-connection-pool.test.ts`）
- [x] `pool_size=3` 多 slot 连接池功能测试（`hub-connection-pool.test.ts`：单/双 Edge 连接、多用户并发认证、跨 Edge 用户可见性、频道操作、用户加入离开事件传播）

#### 依赖
无

#### 参考
- TypeScript: `hub_server.pool_size`
- 文档: `docs/hub-edge-connection-pool.md`, `docs/connection-pool-refactoring.md`

---

### 4. 客户端建议配置

**优先级**: P3  
**状态**: 不实现

#### 功能描述
Edge 向客户端发送建议：
- `client.suggest_version` - 建议版本号
- `client.suggest_positional` - 位置音频
- `client.suggest_push_to_talk` - PTT

#### 实现任务
- [ ] 添加 `client` 配置结构（暂不实现：与 Hub suggest 功能重复）
- [ ] 在 ServerConfig 消息中包含（暂不实现）
- [ ] 客户端连接时发送（暂不实现）

#### 集成测试
- [ ] ServerConfig 包含建议测试（暂不实现）
- [ ] 各种建议组合测试（暂不实现）

#### 依赖
无

#### 备注
实用性有限，与 Hub 的相同功能重复。

---

### 5. 经由 Peer Edge 中继控制信道

**优先级**: P2  
**状态**: ✅ 已完成（核心实现）

#### 功能描述
当 Edge 无法直连 Hub 时（网络分区、临时故障），可借助集群内其他 Edge 作为中继，将控制信道消息转发到 Hub。
**注意**：该功能仅适用于控制信道（RPC/通知），不用于语音转发（语音有单独的三跳 UDP 中继）。

#### 设计文档
- `rust/docs/peer-proxy-design.md` — 详细的架构设计、协议变更、实现说明

#### 实现方式
**自动路由**（类似语音路由机制）：每个 Edge 自动启动 relay 服务器（无需任何 opt-in 标志），监听 `relay_port`（默认 `edge_port + 2`）。当 Edge 无法直连 Hub 时：
1. 先尝试静态配置的 peers（`hub_server.static_peers`，用于 Hub 完全不可达时的启动引导）
2. 再尝试动态发现的 peers（通过 `hub.peerJoined` 广播接收到的节点）

Hub 侧无需任何修改（relay 完全透明）。

#### 与语音路由类比
| 语音路由 | 控制信道中继 |
|---|---|
| 直连 UDP | 直连 Hub WebSocket |
| Hub TCP 中继 | Peer Edge relay（透明转发） |
| 三跳 UDP relay（A→B→C） | 静态 peer + 动态 peer fallback |
| `PeerRegistry` 存储 UDP 地址 | `PeerRegistry` 存储 relay_port |

#### 实现任务
- [x] 设计 Edge 间控制中继协议（透明 WebSocket relay，无需新 RPC 消息类型）
- [x] `EdgeRegisterParams` 添加 `relay_port` 字段（tag=10），Hub 注册时保存并广播
- [x] `HubClusterPeerJoinedParams` 添加 `relay_port` 字段（tag=5），`hub.peerJoined` 通知携带
- [x] `PeerInfoProto` 添加 `relay_port` 字段（tag=7），`edge.join` 响应携带已有 peer 的 relay 端口
- [x] Edge: 实现 relay 服务器（`relay_server.rs`），接受 WebSocket 连接并中继到 Hub
- [x] Edge: **每个 Edge 自动启动** relay 服务器（`server.rs`，无需 `allow_peer_proxy` 标志）
- [x] Edge: 注册时携带 `relay_port`，接收 `hub.peerJoined` 时存储 peer 的 `relay_port`
- [x] Edge: `run_single_slot` 中增加中继回退逻辑（3 次直连失败后依次尝试 static_peers 和 dynamic peers）
- [x] 配置项：`hub_server.relay_port` — relay 监听端口（0 = 自动 `edge_port+2`）
- [x] 配置项：`hub_server.static_peers` — 静态 peer 列表（`[{host, relay_port}]`），用于 Hub 完全不可达时的启动
- [x] `EdgeState.PeerEdgeInfo` 添加 `host` 和 `relay_port` 字段（替代旧的 `proxy_port`）
- [x] `PeerRegistry.relay_peers()` 方法，返回有 relay_port 的 peer 列表
- [x] `PeerRegistry.all_udp_peers()` 方法，用于语音三跳 relay 候选选择
- [x] relay 连接建立后正常执行 register/fullSync/joinCluster 流程
- [ ] relay 链路的超时和健康检查（留待后续实现）
- [x] 直连恢复后自动切回直连（每轮先尝试直连，逻辑已在 `run_single_slot` 中）

#### 语音三跳 relay 路由
- [x] 实现 `RELAY_MAGIC` 常量（`[0xC1, 0xDE]`），区分普通 edge 包和 relay 转发包
- [x] `route_voice()` 新增第三条路径：直连 UDP 失败 → 尝试三跳 relay（通过任意已知 peer）→ Hub TCP 兜底
- [x] `try_relay_via_peer()` — 遍历 PeerRegistry 中的所有已知 peer 作为中继节点
- [x] `handle_relay_packet()` — 接收 relay 包并转发到目标 Edge

#### 集成测试
- [x] `peer-proxy.test.ts` — diagnose 总是显示 control_relay: enabled 及 relay_port（4 个配置测试）
- [x] `peer-proxy.test.ts` — relay 服务器监听端口 TCP 可达性测试
- [x] `peer-proxy.test.ts` — 集群以 relay_port 配置正常启动测试
- [ ] Edge 无法直连 Hub 时通过 static peer relay 完成 register/auth 测试（需要可控网络断开）
- [ ] 三跳语音 relay 功能测试（需要特殊测试拓扑）

#### 依赖
- Hub 连接池（Edge #3）
- Edge 间连接可靠性机制

#### 参考
- 设计文档: `rust/docs/peer-proxy-design.md`
- 实现文档: `rust/docs/voice-routing-and-control-relay.md`

---

## 其他系统性改进

### 1. 性能优化

**优先级**: P1  
**状态**: 📋 计划中

#### 任务
- [ ] 异步 I/O 优化
- [ ] 内存分配优化
- [x] 数据库查询优化（`check_ip_banned` 改为只查询未过期 ban，避免全表扫描）
- [ ] 消息序列化优化
- [ ] 连接处理优化
- [ ] 基准测试套件

#### 测试
- [ ] 性能基准测试（❌ 不实现：当前优先级不足）
- [ ] 负载测试（❌ 不实现：当前优先级不足）
- [ ] 内存泄漏测试（❌ 不实现：当前优先级不足）
- [ ] 并发连接测试（❌ 不实现：当前优先级不足）

---

### 2. 监控和可观测性

**优先级**: P2  
**状态**: ✅ 基础实现已完成（分布式追踪不实现）

#### 任务
- [x] Prometheus metrics 导出（`GET /metrics`：`connected_edges`、`total_sessions`、`total_channels`、`uptime_seconds`）
- [x] 健康检查端点（`GET /api/health`）
- [x] 详细的结构化日志（`log_format = "json"` 配置项，支持 JSON 格式化输出；`init_logging_with_format()` 函数）
- [x] 更多性能指标（每 Edge 标签化指标：`edge_user_count`、`edge_channel_count`、`edge_online`、`edge_uptime_seconds`，附 `edge_id` / `edge_name` 标签）
- [ ] 分布式追踪（OpenTelemetry）❌ **不实现**：引入 OTel SDK 属于重量级依赖，与当前架构优先级不符；结构化 JSON 日志已满足可观测性需求

#### 测试
- [x] Metrics 端点测试（`web-api.test.ts`：格式验证、edge count ≥ 1）
- [x] 每 Edge 标签化指标测试（`web-api.test.ts`：per-edge 标签存在性、edge_id/edge_name 格式、online=1 验证）
- [x] 健康检查测试（`web-api.test.ts`）
- [x] 日志格式测试（`log-format.test.ts`：Hub/Edge JSON 日志逐行验证、文本格式检测、startup 结构化字段验证）

---

### 3. 运维工具

**优先级**: P2  
**状态**: ✅ 已完成

#### 任务
- [x] 数据库迁移工具（`migrate [config]` 子命令：查看当前版本、应用待迁移项、记录版本历史到 `schema_versions` 表）
- [x] 配置验证工具（`validate-config [path]` 子命令，Hub/Edge 均已实现）
- [x] 备份工具（`backup <config> <dest>` 子命令：VACUUM INTO 备份 DB、递归复制 blobs、写入 manifest.json）
- [x] 诊断工具（`diagnose [path]` 子命令，Hub/Edge 均已实现）：配置解析验证、文件存在性检查（DB/blob/TLS证书/Lua脚本/GeoIP DB）、Hub TCP 可达性探测、配置摘要打印
- [x] 批量管理脚本（`admin <config> <cmd>` 子命令：`list-users`、`list-channels`、`list-bans`、`cleanup-bans`、`schema-version`）

#### 测试
- [x] `diagnose.test.ts` — Hub/Edge diagnose 全覆盖（13 个测试）
- [x] `hub-admin.test.ts` — migrate、backup、admin 全覆盖（16 个测试）

---

## 测试覆盖率追踪

### Hub Server 集成测试

| 功能模块 | 测试覆盖 | 状态 |
|---------|---------|------|
| 认证（本地数据库） | ✅ | tests/integration/suites/auth.test.ts |
| 认证（HTTP） | ✅ | tests/integration/suites/auth.test.ts |
| 认证（Lua） | ✅ | tests/integration/suites/lua-auth.test.ts (Rust only) |
| Edge 注册 | ✅ | tests/integration/suites/edge-cluster-join.test.ts |
| 频道管理 | ✅ | tests/integration/suites/channel.test.ts |
| ACL 权限 | ✅ | tests/integration/suites/acl*.test.ts |
| 用户状态同步 | ✅ | tests/integration/suites/user-state-broadcast.test.ts |
| Hub 重启恢复 | ✅ | tests/integration/suites/hub-restart.test.ts |
| Web API | ✅ | tests/integration/suites/web-api.test.ts (Rust only) |
| Blob 存储 | ✅ | tests/integration/suites/blob-storage.test.ts (TS only) |
| 自动封禁 | ✅ | tests/integration/suites/auto-ban.test.ts |
| 频道记忆 | ✅ | tests/integration/suites/channel-memory.test.ts |
| 集群分割探测（Hub 侧） | ✅ | 已实现 shutdownRequest 处置（`handle_partition_after_disconnect`） |
| 集群分割处置（Edge 侧） | ✅ | 已实现 hub.shutdownRequest 处理（`EdgeEvent::ShutdownRequested`） |
| 消息限制 | ✅ | tests/integration/suites/message-limits.test.ts |
| 用户名/频道名验证规则 | ✅ | tests/integration/suites/validation-rules.test.ts (Rust only) |

### Edge Server 集成测试

| 功能模块 | 测试覆盖 | 状态 |
|---------|---------|------|
| 客户端连接 | ✅ | tests/integration/suites/hub-edge.test.ts |
| UDP 连接 | ✅ | tests/integration/suites/udp-connection.test.ts |
| TCP 语音 | ✅ | tests/integration/suites/tcp-voice.test.ts |
| 语音路由 | ✅ | tests/integration/suites/voice*.test.ts |
| 语音路由策略（tcp_only / direct_only / auto_fallback） | ✅ | tests/integration/suites/voice-routing-strategy.test.ts (Rust only) |
| 语音三跳 relay 路由（A→B→C UDP） | ⚠️ | `RELAY_MAGIC` + `RouteDecision::RelayVia` 已实现，端到端测试需要特殊拓扑 |
| 质量感知路由（UDP probe + Hub 路由表推送） | ⚠️ | 核心逻辑已实现（probe/reportQuality/routeTableUpdate），端到端质量路由测试需多 Edge 拓扑 |
| Edge 间连接 | ✅ | tests/integration/suites/edge-cluster-join.test.ts |
| 语音加密 | ✅ | tests/integration/suites/edge-voice-encryption.test.ts |
| 包丢失计算 | ✅ | tests/integration/suites/edge-packet-loss-calculation.test.ts |
| 多租户 SNI | ✅ | tests/integration/suites/multi-tenant-sni.test.ts (TS only) |
| GeoIP（连接时查询位置） | ✅ | geoip.rs 单元测试（Rust only） |
| GeoIP（基于位置的路由） | ❌ | 不实现 |
| 连接池（pool_size=1 默认） | ✅ | Hub 连接池已实现，向后兼容性在 `hub-connection-pool.test.ts` 中验证 |
| 连接池（pool_size=3 多 slot） | ✅ | tests/integration/suites/hub-connection-pool.test.ts (Rust only) |
| LISTEN 权限检查 | ✅ | tests/integration/suites/acl.test.ts（'should deny second user from listening to restricted channel'） |
| 结构化 JSON 日志格式 | ✅ | tests/integration/suites/log-format.test.ts (Rust only) |
| 每 Edge 标签化 Prometheus 指标 | ✅ | tests/integration/suites/web-api.test.ts（per-edge 标签验证，Rust only） |
| 诊断工具（`diagnose` 子命令） | ✅ | tests/integration/suites/diagnose.test.ts（Hub/Edge 各 6-7 用例，Rust only） |
| 数据库迁移工具（`migrate` 子命令） | ✅ | tests/integration/suites/hub-admin.test.ts（4 用例，Rust only） |
| 数据库备份工具（`backup` 子命令） | ✅ | tests/integration/suites/hub-admin.test.ts（5 用例，Rust only） |
| 批量管理工具（`admin` 子命令） | ✅ | tests/integration/suites/hub-admin.test.ts（7 用例，Rust only） |
| 控制信道中继（always-on relay，自动路由） | ✅ | tests/integration/suites/peer-proxy.test.ts（7 用例：配置/relay 端口/服务器可达性，Rust only） |

---

## 实现优先级排序

### 立即实现（P0）
1. **带宽和消息限制配置** (Hub #3) - ✅ 已完成
   - 添加配置项、令牌桶速率限制器、消息长度验证、集成测试
2. **频道记忆功能** (Hub #6) - ✅ 已完成
   - 用户离线保存频道、重连恢复频道、集成测试
3. **监听者功能** (Hub #10) - ✅ 已完成（基础实现）
   - 监听者状态管理、跨频道音频路由实现

### 尽快实现（P1）
4. **语音路由策略配置（Hub）** (Hub #11) - ✅ 已完成（含质量感知路由）
   - 质量指标收集（UDP 探针）、Hub 路由表计算和推送、Edge 路由决策应用
5. **详细的语音路由配置（Edge）** (Edge #1) - ✅ 已完成（含质量感知路由）
   - UDP 质量探测（ping/pong）、edge.reportQuality 上报、按 Hub 路由表智能路由
6. **集群分割探测与处置** (Hub #12) - ✅ 已完成
   - Hub 侧 shutdownRequest 处置、Edge 侧 hub.shutdownRequest 处理、集成测试
7. **Blob 存储系统** (Hub #2) - ✅ 已完成
   - 文件系统存储，SHA-256 分片目录，支持用户头像/评论，内容寻址去重
8. **自动封禁系统** (Hub #5) - ✅ 已完成（基础实现）
   - 配置结构、IP 追踪、时间窗口滑动计数、自动封禁写入 DB、集成测试
9. **客户端建议配置** (Hub #7 / Edge) - ✅ 已完成
   - EdgeConfig suggest 结构、SuggestConfig 消息发送
10. **Hub 连接池** (Edge #3) - ✅ 已完成
    - 多并发 WebSocket 连接、round-robin 负载均衡、per-slot 独立重连（含指数退避）
11. **性能优化** (其他 #1) - 📋 计划中
    - 基础优化已做（DB 查询）；benchmark 套件不实现

### 可以延后（P2）
12. **Web API 接口** (Hub #1) - ✅ 已完成
    - 管理和监控接口：status/edges/stats/topology/health/bans/metrics（含每 Edge 标签化 Prometheus 指标）
13. **用户名和频道名验证规则** (Hub #4) - ✅ 已完成
    - 正则验证规则（`validation.username_regex`、`validation.channel_name_regex`）
14. **监控和可观测性** (其他 #2) - ✅ 基础实现已完成
    - Prometheus metrics（全局+每 Edge 标签化）和结构化 JSON 日志已实现；分布式追踪❌不实现
15. **运维工具** (其他 #3) - ✅ 已完成
    - migrate/backup/admin/validate-config/diagnose 全部实现
16. **经由 Peer Edge 中继控制信道** (Edge #5) - ✅ 已完成（核心实现）
    - 自动路由（always-on relay + static_peers + 动态发现）；语音三跳 relay 已实现；端到端网络分区场景测试不实现

### 按需实现（P3）
17. **Channel Ninja 功能** (Hub #9) - 暂不实现
    - 隐藏特定频道用户
18. **GeoIP 功能** (Edge #2) - ❓ 待定
    - 地理位置查询
19. **客户端建议配置（Edge）** (Edge #4) - 不实现
    - 与 Hub 功能重复

### 不实现
20. **服务器注册（公共列表）** (Hub #8) - ❌ 不实现
    - 现代部署不需要此功能

---

## 贡献指南

### 开始实现新功能

1. 在本文档中将状态更新为 🚧 进行中
2. 创建功能分支：`git checkout -b feature/功能名`
3. 实现功能代码
4. 编写单元测试
5. 编写集成测试
6. 更新配置文档
7. 提交 PR

### 测试要求

- 所有新功能必须有对应的集成测试
- 测试应覆盖正常流程和边界情况
- 测试必须在 Rust 模式下通过：`MUNODE_USE_RUST=1 pnpm test:integration`

### 文档要求

- 更新配置示例文件
- 更新 TOML_CONFIG_GUIDE.md
- 添加功能使用文档（如有必要）
- 更新本 TODO 文档

---

## 更新日志

- 2026-03-10: 初始版本，列出所有未实现功能
- 2026-03-10: 实现 Hub #4 用户名/频道名验证规则（`validation.username_regex`、`validation.channel_name_regex`），添加集成测试 `validation-rules.test.ts`
- 2026-03-11: 实现运维工具 #配置验证（`validate-config [path]` 子命令，Hub/Edge main.rs 均已添加）
- 2026-03-11: 实现 Edge 重连指数退避（`ExponentialBackoff`，hub_client.rs，基础间隔翻倍上限 30s）
- 2026-03-12: 新增集成测试 `lua-auth.test.ts`（Rust 专用，9 个用例：有效凭据连接成功、无效密码/用户名拒绝、多用户并发连接、ServerSync 验证）
- 2026-03-12: 新增集成测试 `voice-routing-strategy.test.ts`（Rust 专用，9 个用例：tcp_only / direct_only / auto_fallback 三种策略各 3 个测试）
- 2026-03-12: 新增集成测试 `log-format.test.ts`（Rust 专用，5 个用例：Hub/Edge JSON 格式验证、Hub/Edge startup 结构化字段检查、文本格式反例验证）
- 2026-03-12: 新增集成测试 `hub-connection-pool.test.ts`（Rust 专用，7 个用例：pool_size=3 多用户连接、跨 Edge 用户同步、频道操作、join/leave 事件传播、pool_size=1 向后兼容）
- 2026-03-12: 修改 `setup.ts` — `startRustEdgeServer` 对 `hub_server` 做深度合并，支持通过 `rustEdgeExtraConfig.hub_server.pool_size` 等字段覆盖单个 hub_server 属性而不替换整个块
- 2026-03-12: 扩展 Hub `GET /metrics` — 新增每 Edge 标签化 Prometheus 指标（`edge_user_count`、`edge_channel_count`、`edge_online`、`edge_uptime_seconds`），`edge_id` / `edge_name` 标签，按 `edge_id` 排序
- 2026-03-12: 新增 Hub `diagnose [path]` 子命令 — 配置解析、DB 目录可达性、blob 目录可达性、Lua 脚本文件存在性、GeoIP 文件存在性、Web API 地址、完整配置摘要
- 2026-03-12: 新增 Edge `diagnose [path]` 子命令 — 配置解析、TLS cert/key/CA 文件存在性、Hub TCP 可达性探测（3s 超时）、连接池大小、连接策略、完整配置摘要
- 2026-03-12: 新增集成测试 `diagnose.test.ts`（Rust 专用，13 个用例：Hub/Edge 各类检查项、无效配置退出码验证）
- 2026-03-12: 扩展集成测试 `web-api.test.ts` — 新增 4 个每 Edge 标签化指标测试（HELP/TYPE 行存在性、标签格式、online=1 验证）
- 2026-03-12: 更新 TODO.md：将 `更多性能指标`、`诊断工具` 标记为 ✅ 已完成；更新测试覆盖率追踪表；更新实现优先级排序
- 2026-03-12: 新增 Hub `migrate` / `backup` / `admin` 子命令；新增集成测试 `hub-admin.test.ts`（16 用例）
- 2026-03-12: 重新设计控制信道中继——移除 `allow_peer_proxy` opt-in 标志和 `proxy_ws_port`；改为 always-on `relay_server.rs` + `hub_server.relay_port`（自动派生 `edge_port+2`）+ `hub_server.static_peers`；动态发现仍通过 `hub.peerJoined` 广播 `relay_port`；与语音路由机制完全对齐
- 2026-03-12: 实现语音三跳 relay 路由（`RELAY_MAGIC [0xC1,0xDE]`）：`try_relay_via_peer()` + `handle_relay_packet()`，当直连 UDP 失败时通过任意已知 peer 转发，与 Hub TCP relay 互为补充
- 2026-03-12: 更新 `peer-proxy-design.md` 详细记录新设计；更新集成测试 `peer-proxy.test.ts` 匹配新 API（7 用例）；标记 OpenTelemetry / GeoIP 位置路由 / Ninja 音频隔离 / 集群分区网络测试 / 性能基准 ❌ 不实现
- 2026-03-12: 新增 `rust/docs/voice-routing-and-control-relay.md`，全面记录 Rust 语音平面（UDP 三级路由、包格式、连接策略配置）和控制信道平面（透明 WebSocket relay、三级回退、peer 发现）的实现细节；更新 TODO.md 相关条目的参考链接；标记"直连恢复后自动切回直连"为已完成（`run_single_slot` 逻辑已实现）
- 2026-03-12: **全面实现质量感知智能路由系统**：新增 UDP 探针协议（PROBE_MAGIC=0xC2,0xDE，每 10s ping/pong）、PeerQualityState RTT/丢包跟踪、report_quality RPC 每 30s 上报到 Hub；Hub 新增 compute_route_table()（Dijkstra + PACKET_LOSS_PENALTY_MS=500）和 push_route_tables_to_all()；Edge 新增 RouteDecision 枚举（Direct/RelayVia/HubTcp）和 route_table 存储；路由决策从"直连优先"改为"按 Hub 路由表决策"；新增 HubRouteEntryProto + HubRouteTableUpdateParams protobuf 消息（tag=36）；更新文档 voice-routing-and-control-relay.md 至版本 2.0

---

## 尚未完成的 TODO（汇总）

以下为所有尚未完成或有子项目未完成的 TODO，供快速查阅：

### 有子项目未完成（功能主体已实现）

| TODO | 未完成子项 | 说明 |
|------|-----------|------|
| Hub #10 监听者功能 | 音频路由隔离测试 | ❌ 不实现 |
| Hub #12 集群分割 | 仲裁测试、最小子集群关停测试 | ❌ 不实现（需可控网络断开） |
| Edge #2 GeoIP | 基于位置的 Edge 分配 | ❌ 不实现 |
| Edge #4 客户端建议配置 | 全部子项 | ❌ 不实现（与 Hub 功能重复） |
| Edge #5 控制信道中继 | relay 超时健康检查；网络分区端到端测试；语音三跳 relay E2E 测试 | 超时健康检查留待后续；测试需可控网络断开 |
| 其他 #1 性能优化 | benchmark 套件、负载/内存/并发测试 | ❌ 不实现（优先级不足） |
| 其他 #2 监控可观测性 | 分布式追踪（OpenTelemetry） | ❌ 不实现 |

### 有意不实现的功能

| TODO | 原因 |
|------|------|
| Hub #8 服务器注册（公共列表） | 现代部署不需要 |
| Hub #9 Channel Ninja 音频路由隔离 | 用户可见性已隔离；UDP 层过滤工作量大，无实际需求 |
| Edge #4 客户端建议配置（Edge 侧） | 与 Hub #7 功能重复 |
| GeoIP 基于位置的 Edge 路由 | Hub 选路逻辑复杂，当前规模实用性有限 |
| 分布式追踪（OpenTelemetry） | 重量级依赖，结构化 JSON 日志已满足需求 |
| 性能基准测试套件 | 当前优先级不足 |
| 集群分区可控网络断开测试 | 需要 iptables/tc 等基础设施，测试成本高 |
