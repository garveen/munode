# 不影响客户端兼容性的缺失功能

> 本文件列出 Murmur 已有、但 MuNode Rust 服务端尚未实现的功能，
> 这些功能的缺失**不会**影响标准 Mumble 客户端的正常使用体验，
> 属于管理功能、扩展接口或服务器端增强特性。

---

## 1. ICE（ZeroC Ice）RPC 接口

**Murmur 实现**：`MumbleServerIce.cpp`、`MumbleServer.ice`

Murmur 提供完整的 ZeroC Ice 进程外 RPC 接口，允许外部程序通过 Ice 协议管理服务器。

**功能清单**：

| 功能 | 说明 |
|---|---|
| `ServerAuthenticator` 接口 | 外部认证服务（阻塞式）|
| `ServerUpdatingAuthenticator` | 可更新认证器（写入用户属性）|
| `ServerCallback` 接口 | 服务端事件监听器（用户连接/断开/消息等）|
| 用户管理 | `kickUser`、`sendMessage`、`getState`/`setState`、`getUserNames`/`getUserIds` |
| 频道管理 | `addChannel`/`removeChannel`、`getChannelState`/`setChannelState` |
| ACL 管理 | `getACL`/`setACL`、`addUserToGroup`（临时组）|
| 上下文动作 | `addContextCallback`/`removeContextCallback`（右键菜单项）|
| Whisper 重定向 | `redirectWhisperGroup`（将低语重定向到不同组）|
| 文字消息过滤 | `textMessageFilterSig`（可拦截/修改消息）|
| 服务器管理 | `start`/`stop`、`delete`、`isRunning`（via MetaCallback）|
| 日志访问 | `getLog`（分页获取服务器日志）|
| 统计 | `getUptime`、`getUsers`、`getChannels` |
| ICE 认证鉴权 | `icesecretread`/`icesecretwrite` 独立密钥 |

**MuNode 现状**：MuNode 用 WebSocket JSON RPC（Hub-Edge 内部协议）替代了 ICE，但没有提供对外的 ICE 兼容接口。外部程序无法通过 ICE 协议集成。

---

## 2. Zeroconf/Bonjour 网络服务自动发现

**Murmur 实现**：`Zeroconf.h/.cpp`、`BonjourServiceRegister`

- 在局域网通过 mDNS 广播 `_mumble._tcp` 服务记录
- Mumble 客户端服务器浏览器可自动发现本地服务器
- 跨平台支持（macOS Bonjour / Windows DNS-SD / Linux Avahi）
- 通过 `bonjour=true` 配置开关

**MuNode 现状**：不支持 Zeroconf/mDNS 服务发现。

---

## 3. 公共服务器列表注册（mumble.info）

**Murmur 实现**：`Register.cpp`

- 向 Mumble 官方公共服务器列表注册（`https://mumble.info/`）
- 注册字段：服务器名称、密码保护标志、主机名、位置、网站
- 定时心跳维持注册有效性
- `bAllowPing` 允许公共探测（用于公共列表显示延迟）

**MuNode 现状**：不支持公共列表注册，也没有 `bAllowPing` 配置。

---

## 4. 多虚拟服务器（Virtual Servers）

**Murmur 实现**：`Meta.h`、`MetaCallback`

- 单进程运行多个独立虚拟服务器（各自独立端口、配置、DB）
- 虚拟服务器通过 ICE 接口动态创建/销毁
- 每台虚拟服务器独立的 TLS 证书、欢迎语、ACL
- 全局 `[meta]` 配置 + 每服务器覆盖配置

**MuNode 现状**：单进程单服务器架构。多服务器通过部署多个 Hub+Edge 实例实现（分布式而非单进程多虚拟服务器）。

---

## 5. TLS 证书自动生成（自签名证书）

**Murmur 实现**：`SelfSignedCertificate.h/.cpp`、`Cert.cpp`

- 启动时若无配置证书，自动生成 2048-bit RSA 自签名证书
- 服务器证书的 CN 包含主机名和随机序号
- 支持加密私钥（PEM passphrase）
- 支持证书链（`qlIntermediates`）
- `isKeyForCert()` 验证密钥与证书匹配

**MuNode 现状**：需要手动提供 TLS 证书和私钥，无自动生成功能。

---

## 6. 服务端持久化操作日志（LogTable）

**Murmur 实现**：`database/LogTable.cpp`

- 所有管理员操作和重要事件写入 SQLite `log` 表
- 可通过 ICE `getLog()` 接口分页检索历史日志
- 记录内容：时间戳、用户名、消息文本
- 事件类型：用户连接/断开、频道创建/删除、ACL 变更、封禁操作等

**MuNode 现状**：日志仅输出到 stdout/文件（通过 `tracing`），不持久化到数据库，无审计查询接口。

---

## 7. 详细 ACL 变更日志（`bLogGroupChanges` / `bLogACLChanges`）

**Murmur 实现**：`Meta.h: MetaParams::bLogGroupChanges / bLogACLChanges`

- 可选配置，记录每次 ACL 和群组变更的详细日志
- 记录变更前后的差异，用于安全审计

**MuNode 现状**：ACL 变更操作只有简要日志，无差异比较和详细审计。

---

## 8. 用户 Email 字段

**Murmur 实现**：`database/UserProperty.h: UserProperty::Email`，`DBWrapper.cpp`

- 注册用户可存储邮箱地址（`qslEmail`）
- ICE `setInfo()`/`getInfo()` 可读写邮箱
- 可用于按邮箱查找用户（`getUserId()` 支持邮箱查询）

**MuNode 现状**：用户表中没有 email 字段，无邮箱存储和查询功能。

---

## 9. PBKDF2 遗留密码 hash 兼容迁移

**Murmur 实现**：`PBKDF2.h/.cpp`、`LegacyPasswordHash.h/.cpp`

- 读取并验证旧版 SHA1 密码 hash（向上兼容）
- 首次登录时自动将旧 hash 迁移至 PBKDF2 格式
- KDF 迭代次数自适应（基准测试 `benchmark()` 确定）
- 迭代次数存储于 `UserProperty::KDFIterations`

**MuNode 现状**：统一使用 Argon2 hash，无 PBKDF2 旧 hash 读取或迁移路径。无法直接读取 Murmur 旧数据库（如果密码以旧格式存储）。

---

## 10. 频道监听音量调整广播控制（`broadcastListenerVolumeAdjustments`）

**Murmur 实现**：`Server.h: broadcastListenerVolumeAdjustments`

- 配置项控制监听音量调整变更是否广播给其他用户
- 若 `false`：音量调整仅发给调整者自己（默认 Mumble 行为期望）
- 若 `true`：广播给所有用户（旧版兼容行为）

**MuNode 现状**：始终将监听音量调整广播给所有人，无此配置项控制。

---

## 11. Access Token 大小写不敏感配置

**Murmur 实现**：`Group::accessTokenCaseSensitivity`

- 全局配置 Access Token 的比较是否大小写不敏感
- 默认大小写敏感，可配置为不敏感

**MuNode 现状**：Token 比较始终大小写敏感，无配置项。

---

## 12. 频道监听持久化 DB 表（ChannelListeners）

**Murmur 实现**：`database/ChannelListenerTable.cpp`、`DBWrapper: loadChannelListenersOf`

- `channel_listeners` 表存储注册用户的频道监听关系
- 登录时通过 `loadChannelListenersOf()` 恢复
- 登出时通过 `saveChannelListeners()` 持久化

**MuNode 现状**：DB schema 中无 `channel_listeners` 表，无持久化机制。  
（注：此条同时出现在 [missing-client-compatibility.md](missing-client-compatibility.md) 中，因为它也影响用户体验）

---

## 13. 欢迎文字文件（`qsWelcomeTextFile`）

**Murmur 实现**：`Server.h: qsWelcomeTextFile`

- 支持从外部文件加载欢迎消息（可包含多行 HTML）
- 文件内容在每次连接时读取（支持热更新）

**MuNode 现状**：`welcome_text` 仅支持配置文件内的内联字符串。

---

## 14. 连接频率自动封禁（Meta 级别）

**Murmur 实现**：`Meta.h: iBanTries / iBanTimeframe / iBanTime`，`bBanSuccessful`

- 全局连接频率统计（按 IP），独立于按密码失败的封禁
- 短时间内连接次数超限自动封禁（`iBanTries`/秒）
- `bBanSuccessful`：已封禁 IP 的成功连接是否也计入统计

**MuNode 现状**：只有认证失败计数的 auto-ban（`failed_auth_tracker`），无基于连接频率的独立封禁机制。

---

## 15. 上下文动作（Context Actions，协议层完整支持）

**Murmur 实现**：`Messages.cpp: msgContextAction`、ICE `addContextCallback`

- 服务端可向特定用户动态注册右键菜单项（通过 ICE）
- `ContextActionModify` 消息增加/删除右键菜单项
- `ContextAction` 消息传递用户点击事件到 ICE 回调

**MuNode 现状**：协议层有 `ContextActionModify` 和 `ContextAction` 消息类型定义，但 Edge server 的消息处理循环没有处理这两种消息类型（收到后丢弃）。没有对应的 RPC 接口让外部程序注册上下文动作。

---

## 16. 带宽统计记录（BandwidthRecord）

**Murmur 实现**：`Server.h: BandwidthRecord`（360 槽环形缓冲）

- 每用户追踪语音带宽使用历史（360 个时槽）
- `addFrame(size, maxpersec)` 超出带宽限制时丢帧
- `onlineSeconds()` 和 `idleSeconds()` 时间追踪
- 带宽数据包含在 `UserStats` 响应中

**MuNode 现状**：仅有全局最大带宽配置，无按帧精度的带宽统计，`UserStats` 中不包含带宽字段。

---

## 17. 平台守护进程与托盘支持

**Murmur 实现**：`UnixMurmur.cpp`、`Tray.cpp`、`ServerApplication.cpp`

- Unix daemon 模式（fork/double-fork、setsid、umask、pidfile）
- SIGHUP 信号触发配置热重载
- Windows 系统服务（Service Control Manager 集成）
- macOS/Windows 系统托盘图标（服务器状态监控）

**MuNode 现状**：使用 Tokio 直接运行，无平台守护进程封装，无系统托盘，配置变更需重启。

---

## 18. `bAllowPing` 公共服务器 Ping 探测配置

**Murmur 实现**：`Server.h: bAllowPing`

- 控制服务器是否响应非认证的 UDP Ping（用于公共服务器列表展示延迟）
- 默认允许，可禁用以防止服务器被发现

**MuNode 现状**：UDP Ping 响应逻辑存在，但无 `bAllowPing` 开关控制。

---

## 19. 滚动统计窗口配置（`rollingStatsWindow`）

**Murmur 实现**：`Server.h: rollingStatsWindow`，`ServerUser: m_rollingWindow`

- 可配置语音质量统计的滚动时间窗口大小
- 影响 `UserStats::from_client`/`from_server` 的统计粒度

**MuNode 现状**：OCB2 统计计数采用全局累积计数器，无滚动窗口配置。
