# 影响客户端无缝替换的缺失功能

> 本文件列出 Murmur 已有、但 MuNode Rust 服务端尚未实现的功能，
> 这些功能的缺失会导致标准 Mumble 客户端连接时出现行为差异或功能缺失，
> 从而无法做到对客户端的透明无缝替换。

---

## 1. 频道进入状态同步（`is_enter_restricted` / `can_enter`）

✅ **已实现**：`send_channel_tree()` 现在接受 `session_id` 参数，对每个频道调用 Hub `handle_permission_query`，计算 `can_enter` 和 `is_enter_restricted` 并随 `ChannelState` 消息发送给客户端。

**描述**：Murmur 在登录时发送频道树时，为每个频道附带 `is_enter_restricted`（是否有 Enter 拒绝规则）和 `can_enter`（当前用户是否可进入）字段。客户端依赖这些字段显示频道锁定图标和控制 UI 反馈。

**现状**：MuNode 的 `send_channel_tree()` 只发送基础频道属性（名称、父频道、位置等），不包含这两个字段。

**影响**：
- 所有频道对客户端显示为"可进入"，无锁图标
- 客户端 UI 中的频道进入权限提示缺失
- 引发 ACL 受限频道的 UI 混乱（用户看到能进但实际 Move 被拒绝）

**Murmur 对应代码**：`Messages.cpp: msgAuthenticate` 中 `mpcs.set_can_enter(hasPermission(...))` 和 `mpcs.set_is_enter_restricted(...)`

---

## 2. ACL 变更后 `can_enter` 刷新广播

✅ **已实现**：新增 `EdgeEvent::AclUpdated { channel_id }` 事件；Hub 的 `hub.aclUpdated` 通知现在由 `hub_client.rs` 解析并触发该事件；Edge 事件循环收到后对所有本地客户端重新查询权限并发送 `ChannelState` 更新。

**描述**：Murmur 在 ACL 更新后，向所有在线用户广播受影响频道的更新 `can_enter` 状态（ChannelState 消息）。

**现状**：MuNode Hub 有 `hub.aclUpdated` 通知，但 Edge 接收到该通知后不会为每个本地用户重新计算并广播各频道的 `can_enter` 值。

**影响**：
- ACL 变更后，客户端界面中的频道进入权限提示不会更新
- 用户可能看到错误的进入权限（可进但实际无权，或有权但显示不可进）

---

## 3. 已认证用户通过 Authenticate 消息更新 Access Token

✅ **已实现**（部分）：已在 `Ready` 状态添加 `Authenticate` 消息处理，防止未处理警告。完整的 token 刷新（重新评估 can_enter 并广播）尚未实现，需要新的 Hub RPC。

**描述**：Murmur 支持已认证用户发送新的 `Authenticate` 消息（仅含 `tokens` 字段）来更新其访问令牌，随后服务端刷新并广播所有频道的 `can_enter` 更新。

**现状**：MuNode 仅在 `Connected` 状态下处理 `Authenticate` 消息，认证完成后收到的 `Authenticate` 消息被忽略。

**影响**：
- Token-based ACL（如临时访问令牌频道）无法在用户已连接时动态更新
- 客户端无法在不重新连接的情况下更新访问权限

**Murmur 对应代码**：`Messages.cpp: msgAuthenticate` 顶部的已认证用户 tokens 更新分支

---

## 4. `tree_id` 文字消息不递归子频道

✅ **已实现**：`broadcast_text_message` 和 `EdgeEvent::TextMessageForward` 中的 `tree_id` 处理现已递归遍历所有子频道。

**描述**：Murmur 对 `TextMessage.tree_id` 的处理是递归遍历整个频道子树，并在每一级检查 `TextMessage` 权限后广播。

**现状**：MuNode 对 `tree_id` 的处理仅广播到列举的频道本身，不递归到子频道。

**影响**：
- 发往频道树的文字消息无法到达子频道用户
- 管理员/机器人依赖树级消息广播的功能失效

---

## 5. 文字消息缺少 `TextMessage` 权限检查

✅ **已实现**：TextMessage 处理中已添加 `perm::TEXT_MESSAGE` 权限检查，无权限时返回 `PermissionDenied`。

**描述**：Murmur 在转发文字消息到频道前，检查发送者是否拥有目标频道的 `ChanACL::TextMessage` 权限。

**现状**：MuNode 仅做文字消息长度限制和速率限制，没有权限检查。

**影响**：
- 无 TextMessage 权限的用户也能向频道发送消息
- ACL 中对 TextMessage 权限的限制失效

---

## 6. `recording_allowed` 配置不可用，无法阻止用户录音

✅ **已实现**：`send_server_config()` 现在读取 `config.server.recording_allowed`；当 `recording_allowed=false` 时，客户端尝试开启录音会收到 `PermissionDenied`。

**描述**：Murmur 有 `allowRecording` 配置（默认 true），当设置为 false 时：
1. `ServerConfig.recording_allowed` 发送 false，客户端隐藏录音按钮
2. 尝试设置 recording=true 的用户会被踢出

**现状**：MuNode 在 `send_server_config()` 中始终发送 `recording_allowed: Some(true)`，无配置读取，也没有录音阻止逻辑。

**影响**：
- 无法配置禁止用户录音的服务器
- 即使想禁止录音的服务器管理员也无法实现

---

## 7. `allow_html` 硬编码为 true，无服务端 HTML 过滤

✅ **已实现**：`send_server_config()` 现在读取 `config.server.allow_html`；当 `allow_html=false` 时，文字消息中的 HTML 标签在转发前被剥离。

**描述**：Murmur 通过 `bAllowHTML` 配置控制是否允许富文本消息，当 false 时服务端对消息内容进行 HTML 过滤（`isTextAllowed()`）。

**现状**：MuNode 始终发送 `allow_html: Some(true)`，不做 HTML 内容过滤。

**影响**：
- 无法禁用 HTML 文字消息
- 潜在的客户端 XSS 渲染风险（取决于具体客户端实现）

---

## 8. ACL 查询响应中不包含群组（Groups 始终为空）

✅ **已实现**：`handle_acl` 的查询分支现在从 DB 加载 `channel_groups` 和 `channel_group_members`，并在 ACL 查询响应中包含完整的 `ChanGroup` 列表；更新分支也会保存客户端提交的群组及成员数据。

**描述**：Murmur 的 ACL 查询响应（`MumbleProto::ACL`）包含完整的频道群组定义（`ChanGroup`：名称、成员列表、继承设置等）。客户端的 ACL 编辑界面依赖这些数据来管理访问控制组。

**现状**：MuNode 的 `handle_acl` 在 ACL 查询响应中始终返回 `groups: vec![]`。DB 中虽然有 `channel_groups` 和 `channel_group_members` 表，但 ORM 层未与 ACL 管理器集成。

**影响**：
- 客户端 ACL 编辑界面中看不到任何群组
- 无法通过 Mumble 客户端创建或管理频道群组
- 基于群组的权限规则不可见，且无法编辑

---

## 9. ACL 群组成员关系不参与权限计算

✅ **已实现**：`handle_permission_query` 现在在调用 `calculate_permissions` 前，遍历目标频道的祖先链，将 DB 中的群组成员资格追加到 `effective_groups`，使 ACL 中的 `@groupname` 规则正确生效。

**描述**：Murmur 的 ACL 权限计算中，`@groupname` 规则会检查用户是否在该频道（及继承链）的对应群组中。群组成员来自 DB 中的显式成员列表。

**现状**：MuNode 的 `acl_matches_user()` 对群组名仅检查是否在用户的 `groups`（认证时由外部认证服务返回的字符串列表）中，不查询 DB 中的群组成员表。

**影响**：
- 通过客户端 ACL 编辑界面手动添加到群组的用户，其群组成员关系对权限计算无效
- 基于本地 DB 群组的 ACL 规则形同虚设

---

## 10. 临时频道不会在最后一名用户离开时自动删除

✅ **已实现**：`on_user_left` 和 `on_user_moved` 中已添加 `maybe_cleanup_temp_channel()` 调用，空临时频道将自动删除并广播 `channelRemoved`。

**描述**：Murmur 的临时频道（`temporary=true`）在最后一名用户离开后自动删除，并向所有客户端广播 `ChannelRemove`。

**现状**：MuNode 支持创建临时频道（标记 `temporary=true`），但没有实现用户离开触发的空频道清理逻辑。

**影响**：
- 临时频道永久累积，频道列表随时间膨胀
- 客户端看到大量废弃的空临时频道
- 与标准 Mumble 服务端行为不符

---

## 11. 永久频道不能在临时频道内创建（TemporaryChannel 拒绝）

✅ **已实现**：`handle_save_channel` 中已添加父频道临时性检查，在临时父频道内创建永久频道时返回错误。

**描述**：Murmur 在尝试于临时频道内创建永久频道时，返回 `PermissionDenied::TemporaryChannel`。

**现状**：MuNode 不检查父频道是否为临时频道，允许在临时频道中创建永久子频道。

**影响**：
- 违反 Mumble 协议语义（临时频道内不应有持久化内容）
- 父临时频道删除后，子永久频道可能成为孤儿

---

## 12. 频道嵌套深度限制未执行（PermissionDenied: NestingLimit）

✅ **已实现**：`HubLimitsConfig` 新增 `channel_nesting_limit` 字段；`handle_save_channel` 中已添加深度检查。

**描述**：Murmur 配置 `iChannelNestingLimit`，超出时发送 `PermissionDenied::NestingLimit`。

**现状**：MuNode 没有嵌套深度限制检查（`PermissionDenied::NestingLimit` 枚举值存在于协议层但未使用）。

---

## 13. 频道总数限制未执行（PermissionDenied: ChannelCountLimit）

✅ **已实现**：`HubLimitsConfig` 新增 `channel_count_limit` 字段；`handle_save_channel` 中已添加数量检查。

**描述**：Murmur 配置 `iChannelCountLimit`，超出时发送 `PermissionDenied::ChannelCountLimit`。

**现状**：MuNode 没有频道总数限制检查（枚举值存在但未使用）。

---

## 14. 用户名占用检测缺失（UsernameInUse 拒绝类型）

✅ **已实现**：`handle_authenticate_user` 中已添加用户名唯一性检查：相同证书 hash 踢出旧幽灵会话，不同证书返回 `UsernameInUse`(reject_type=4)。

**描述**：Murmur 在两个用户尝试使用同一名称连接时：
- 若相同证书 hash 或相同 IP：踢出旧连接并允许新连接（幽灵用户替换）
- 否则：拒绝新连接，返回 `Reject::UsernameInUse`

**现状**：MuNode 的 Hub `handle_authenticate_user` 不检查用户名唯一性，两个同名用户可同时在线。

**影响**：
- 客户端会看到两个同名用户，造成混乱
- 幽灵检测依赖外部认证服务，无内置机制

---

## 15. UserStats 响应缺少证书、带宽、版本信息

✅ **已实现**（部分）：`ClientInfo` 新增 `client_version`、`client_release`、`client_os`、`client_os_version` 字段，在认证时从 Version 消息填充；UserStats 非 stats_only 响应中现在包含 `version` 字段（含 release/os/os_version）。证书链（`certificates`）尚未实现，因为 TLS 证书需要从握手中捕获原始 DER 数据。

**描述**：Murmur 的 UserStats 响应（非 stats_only 模式）包含：
- `certificates`：目标用户的完整 PEM 证书链
- `bandwidth`：历史带宽使用（BandwidthRecord 环形缓冲数据）
- `version`：目标用户的客户端版本号
- `release`/`os`/`os_version`：系统信息
- `identity`：用户的频道标识

**现状**：MuNode 的 UserStats 只包含加密统计（good/late/lost/resync）、IP 地址、在线时长和 Opus 支持标志。

**影响**：
- 管理员和用户无法通过 Mumble 客户端查看他人的证书信息
- 带宽监控数据缺失

---

## 16. 频道描述发送方式（始终内联，无 hash 懒加载）

✅ **已实现**：`send_channel_tree()` 现在对非空描述计算 SHA1 哈希并发送 `description_hash`，客户端可按需通过 `RequestBlob` 获取全文。

**描述**：Murmur 对 >= 1.2.2 版本的客户端发送 `description_hash`（内容摘要），客户端按需通过 `RequestBlob` 获取全文；对旧版客户端直接发送描述全文。

**现状**：MuNode 的 `send_channel_tree()` 始终发送 `description` 内联字段，不发 `description_hash`。

**影响**：
- 频道描述内容较长时，每次登录产生额外流量
- 不符合 Mumble 1.2.2+ 客户端预期的懒加载协议（功能上正常，但效率低）

---

## 17. 频道监听状态不持久化（登录后不恢复）

✅ **已实现**：DB 方法 `load_channel_listeners` / `save_channel_listeners` 已存在；Edge 在登录完成后调用 `hub_client.load_channel_listeners(user_id)` 恢复持久化的监听状态，在断开连接时调用 `save_channel_listeners` 保存。

**描述**：Murmur 在用户登录时，从 DB 加载其上次的频道监听状态（`loadChannelListenersOf`），恢复订阅关系。

**现状**：MuNode 不持久化频道监听关系，断线重连后用户的监听状态全部丢失。

**影响**：
- 注册用户每次重连后需要手动重新订阅所有监听频道

---

## 18. 位置音频路由（plugin_context / plugin_identity）

✅ **已实现**（部分）：`ClientInfo` 新增 `plugin_context: Vec<u8>` 字段；`ClientManager` 新增 `update_plugin_context()` 方法；`handle_user_state_update` 现在在 UserState 消息中有 `plugin_context` 时更新存储的上下文。实际语音路由过滤（仅向相同 context 的用户路由）尚未实现，需要修改 UDP 热路径。

**描述**：Murmur 在处理语音包时，通过 `plugin_context` 字段过滤语音接收者——只有 `plugin_context` 相同的用户才互相收听位置音频。`plugin_context` 通过 UserState 更新，但不对外广播。

**现状**：MuNode 不处理 `plugin_context` 字段，所有频道内用户收听所有语音。

**影响**：
- 游戏内位置音频（同一游戏服务器实例的玩家才互通）无法工作
- 玩家可能听到不同游戏例程的语音

---

## 19. VoiceTarget 群组过滤（`group` 字段）不生效

✅ **已实现**：语音路由（VoiceTarget channel targets）现在检查 `ch_cfg.group` 过滤器；当设置了群组名时，只向该频道中 `ClientInfo.groups` 包含该群组名的用户发送语音。

**描述**：Murmur 的低语目标配置中，频道目标可附加 `targetGroup` 字段，表示只将语音发送给该频道中属于该群组的用户。

**现状**：MuNode 存储 VoiceTarget 中的 `group` 字段，但在语音路由时不检查用户是否属于该群组，等效于忽略了群组过滤。

**影响**：
- 用于群组定向低语（如 "仅向 moderators 低语"）的功能失效
- 语音发送给频道内所有用户，而非指定群组成员

---

## 20. 全局每频道用户上限（`iMaxUsersPerChannel`）未执行

✅ **已实现**：`ServerLimitsConfig` 新增 `max_users_per_channel` 字段，Hub 在 `build_server_limits()` 中填充该值并通过注册/心跳推送给 Edge；频道移动逻辑现在当频道无单独 `max_users` 时回退到全局 `max_users_per_channel`。

**描述**：Murmur 有全局 `iMaxUsersPerChannel` 配置，作用于所有未单独设置上限的频道，优先级低于频道自身的 `uiMaxUsers`。

**现状**：MuNode 只执行每频道的 `max_users`，无全局每频道默认上限。

---

## 21. 证书必须的拒绝消息缺少用户 session（NoCertificate 类型）

✅ **已实现**：当 Hub 返回 `cert_required=true` 的认证失败时，Edge 先发送 `PermissionDenied { type: MissingCertificate, session }` 消息，再发送兼容性 `Reject { type: NoCertificate }` 消息。

**描述**：Murmur 在 `cert_required=true` 且用户没有提供证书时，发送 `PermissionDenied::NoCertificate`，同时在消息中附带触发该限制的用户 session。

**现状**：MuNode 的 `cert_required` 逻辑由 Hub 在 `edge.authenticateUser` 返回时控制，但 Edge 没有显式发送 `PermissionDenied::NoCertificate` 类型消息，而是使用通用 `Reject` 消息。

**影响**：
- 客户端无法区分无证书拒绝和其他类型的拒绝
- 某些客户端可能无法正确处理无证书时的提示

---

## 22. 欢迎消息文件（`qsWelcomeTextFile`）不支持

✅ **已实现**：`HubAuthConfig` 新增 `welcome_text_file` 字段；`build_server_limits()` 优先从文件读取 MOTD，回退到内联 `welcome_text`。

**描述**：Murmur 支持从文件加载欢迎消息（`welcometextfile` 配置项），可包含 HTML 格式的长文。

**现状**：MuNode 仅支持配置文件中的内联 `welcome_text` 字符串，不支持从文件读取。

---

## 23. 自认证超时检查（连接超时）

✅ **已实现**：认证前使用 `auth_timeout_secs` 作为最大等待时间；超时后发送 `Reject` 并断开连接。

**描述**：Murmur 配置 `iTimeout`，未在超时内完成认证的连接被强制断开（分阶段超时）。

**现状**：MuNode 有统一的 `CLIENT_IDLE_TIMEOUT`（120 秒空闲超时），但不区分认证前阶段的独立超时。

---

## 24. 遗留纹理格式（600×60 BGRA）按客户端版本分发

🚫 **不适用**：MuNode 明确不支持 Mumble 客户端版本 < 1.2.2（发布于 2011 年）。所有受支持的客户端均使用 `texture_hash` + `RequestBlob` 懒加载机制，无需维护遗留 BGRA 格式。MuNode 统一使用新格式行为。

**描述**：Murmur 对 < 1.2.2 的客户端发送完整纹理 blob，对 >= 1.2.2 的客户端发送纹理 hash。旧格式 600×60×4 字节 BGRA 需要特殊处理（大端序标头检测）。

**决定**：此项不予实现，因为超过 10 年历史的客户端版本已无维护价值。

---
