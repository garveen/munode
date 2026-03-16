# Murmur 功能清单（按模块）

> 基于 Mumble 官方 C++ 服务端（`c-implement/src/murmur/`）源码分析。
> 参考版本：mumble-voip/mumble master。

---

## 1. 客户端协议层（Messages.cpp、Server.cpp、MumbleProtocol.h）

### 1.1 TCP/TLS 控制通道

- 全部 27 条 Mumble TCP 消息类型处理：
  `Version` `UDPTunnel` `Authenticate` `Ping` `Reject` `ServerSync`
  `ChannelRemove` `ChannelState` `UserRemove` `UserState` `BanList`
  `TextMessage` `PermissionDenied` `ACL` `QueryUsers` `CryptSetup`
  `ContextActionModify` `ContextAction` `UserList` `VoiceTarget`
  `PermissionQuery` `CodecVersion` `UserStats` `RequestBlob`
  `ServerConfig` `SuggestConfig` `PluginDataTransmission`
- Protobuf 二进制帧协议：`[type:u16][length:u32][payload]`
- SSL/TLS（Qt QSslSocket，支持证书链）
- 按版本区分消息行为（< 1.2.2 / >= 1.2.2 / >= 1.5.0）
- 客户端版本协商（Version 消息解析 release/OS/OS version）

### 1.2 UDP 语音通道

- UDP socket（支持多绑定地址）
- OCB2-AES128 语音加密/解密
- CryptSetup 握手（服务端生成密钥 + nonce）
- Nonce 重同步（客户端请求 `CryptSetup` resetIV）
- 扩展 UDP Ping/Pong（带时间戳）
- TCP Tunnel 回退（通过 `UDPTunnel` 消息在 TCP 上承载语音）
- 按 IP+Port 索引用户（`qhPeerUsers`）
- 每用户原子标志跟踪当前 UDP/TCP 状态（`aiUdpFlag`）

### 1.3 连接生命周期

- 连接建立时分配 Session ID（从预分配队列）
- Ghost 连接检测（同 user_id 或同名用户重连时踢出旧连接）
- 用户名已占用检测（`UsernameInUse`）——允许相同 IP 或证书 hash 的用户重用名称
- 连接超时（`iTimeout` 配置，认证阶段独立超时）
- 超出最大用户数时拒绝（`ServerFull`）
- 证书必须条件（`bCertRequired` → `NoCertificate` 拒绝类型）
- 强制外部认证模式（`bForceExternalAuth`）
- ServerSync 含欢迎语、最大带宽、根频道权限
- SuggestConfig 含建议版本、positional、push-to-talk 提示

### 1.4 速率限制

- 每用户漏桶算法（`LeakyBucket`）
- 控制消息速率限制（`iMessageLimit` / `iMessageBurst`）
- 插件消息独立速率限制（`iPluginMessageLimit` / `iPluginMessageBurst`）
- 全局自动封禁（连接尝试频率超限 → 写入 bans 表）

---

## 2. 认证与用户管理（Messages.cpp:msgAuthenticate、DBWrapper.cpp）

### 2.1 认证方式

- 用户名 + 密码（本地 SQLite 数据库）
- X.509 客户端证书（SHA-1 hash 匹配注册用户）
- 服务端证书链信任验证（`bVerified`/`bStrongCert`）
- ICE 外部认证器（`ServerAuthenticator` 接口，实时协议）
- 认证结果码：-1=失败，-2=未知用户，-3=临时不可验证

### 2.2 密码存储

- PBKDF2 + 自适应迭代次数（基准测试确定）
- 遗留 SHA1 hash（升级兼容性）
- KDF 迭代次数存入 DB（`UserProperty::KDFIterations`）
- Argon2（在代码重构版本中）

### 2.3 用户注册与管理

- 用户自注册（需 `ChanACL::SelfRegister` 权限）
- 管理员注册用户（需 `ChanACL::Register` 权限）
- 用户注销（通过 `UserList` 消息中将名称置空）
- 用户重命名（通过 `UserList`）
- 用户属性 map：Name / Email / Comment / Hash / Password / LastActive / KDFIterations
- 用户纹理/头像（zlib 压缩 600×60 BGRA 旧格式 或新格式）
- 用户评论（带 hash 的延迟加载，RequestBlob 触发）
- SuperUser（ID=0）特殊保护——不可踢出、不可封禁
- 用户 ID / 用户名双向缓存（`qhUserNameCache` / `qhUserIDCache`）

### 2.4 访问令牌（Access Tokens）

- 每用户字符串列表（`qslAccessTokens`）
- 令牌大小写不敏感模式（`Group::accessTokenCaseSensitivity`）
- 临时访问令牌（RAII scope，`TemporaryAccessTokenHelper`）
- 已认证用户发送新 `Authenticate` 消息更新令牌 → 刷新全部频道 `can_enter` 状态

### 2.5 用户状态属性

- 静音/闭麦（mute/deaf）：服务端强制
- 自我静音/自我闭麦（selfMute/selfDeaf）
- 压制（suppress）：依频道 Speak 权限自动设置
- 优先发言人（priority_speaker）
- 录音标志（recording）：服务端可禁止录音（`allowRecording=false` → 踢出）
- 插件上下文（plugin_context）：不对外广播
- 插件身份（plugin_identity）：不对外广播
- Client 类型（BOT，计入 `m_botCount` 统计）

---

## 3. 频道管理（Messages.cpp、Channel.h/.cpp）

### 3.1 频道基本操作

- 创建永久频道（需 `ChanACL::MakeChannel` 权限）
- 创建临时频道（需 `ChanACL::MakeTempChannel`）
- 临时频道自动删除（最后用户离开后删除）
- 永久频道在临时频道中的创建拒绝（`PermissionDenied::TemporaryChannel`）
- 删除频道及所有子频道（递归）
- 重命名频道
- 移动频道（变更父频道）
- 编辑频道描述（带 hash 懒加载，RequestBlob）
- 设置频道排序位置（`iPosition`）
- 设置每频道最大用户数（`uiMaxUsers`）
- 频道名称正则验证（`qrChannelName`）

### 3.2 频道树结构

- 根频道（ID=0）始终存在，名称为注册名称
- 父子层级结构无限嵌套（受限于 `iChannelNestingLimit`）
- 全局频道数量限制（`iChannelCountLimit`，`PermissionDenied::ChannelCountLimit`）
- 深度嵌套限制（`PermissionDenied::NestingLimit`）
- 防循环引用检测（`canNest()`）
- BFS 遍历完整频道树发送给连接用户

### 3.3 频道链接

- 双向链接（`link`/`unlink`），强度计数（多重链接）
- 链接频道间语音双向广播（`allLinks()`）
- 链接操作需两端均有 `LinkChannel` 权限

### 3.4 进入限制与 `can_enter` 同步

- 检测是否有 `ChanACL::Enter` 拒绝规则（`isChannelEnterRestricted`）
- `ChannelState` 消息上包含 `is_enter_restricted` 和 `can_enter` 字段
- 频道树同步时按用户权限实时计算并发送
- ACL 变更后向所有用户广播受影响频道的更新 `can_enter` 值
- 频道满员检查（`isChannelFull`，Write 权限用户豁免）

### 3.5 频道监听（Channel Listeners）

- 用户可监听不在其中的频道（`ChanACL::Listen` 权限）
- 监听者接收该频道及其链接频道的语音（只收不发）
- 每用户/每频道监听数量限制（`ChannelListenerLimit` PermissionDenied）
- 监听器持久化（注册用户登出后下次登录恢复监听状态，通过 DB）
- 监听音量调整（`broadcastListenerVolumeAdjustments` 配置，可仅发给调整者）

---

## 4. 权限/ACL 系统（ACL.h/.cpp、Messages.cpp:msgACL）

### 4.1 权限位（ChanACL::Perm）

| 值 | 名称 | 说明 |
|---|---|---|
| 0x001 | Write | 写入/控制，隐含除 Speak/Whisper 外所有权限 |
| 0x002 | Traverse | 遍历频道（无此权限无法访问子频道）|
| 0x004 | Enter | 进入频道 |
| 0x008 | Speak | 在频道讲话 |
| 0x010 | MuteDeafen | 静音/闭麦其他用户 |
| 0x020 | Move | 移动用户 |
| 0x040 | MakeChannel | 创建永久子频道 |
| 0x080 | LinkChannel | 链接频道 |
| 0x100 | Whisper | 低语到频道 |
| 0x200 | TextMessage | 发送文字消息 |
| 0x400 | MakeTempChannel | 创建临时子频道 |
| 0x800 | Listen | 监听频道（不在其中）|
| 0x10000 | Kick | 踢出用户（根频道）|
| 0x20000 | Ban | 封禁用户（根频道）|
| 0x40000 | Register | 注册/注销用户（根频道）|
| 0x80000 | SelfRegister | 自我注册（根频道）|
| 0x100000 | ResetUserContent | 重置评论/头像（根频道）|

### 4.2 ACL 规则结构

- 每条 ChanACL：`apply_here`（本频道）、`apply_subs`（子频道）
- 针对 `user_id` 或 `group_name`
- 允许权限集（allow）+ 拒绝权限集（deny）
- `isPassword()` 识别密码式 ACL

### 4.3 ACL 继承与计算

- `bInheritACL` 标志控制是否继承父频道 ACL
- `hasPermission()` 从根到目标频道递归计算有效权限
- `inherit_acl=false` 时重置为默认权限（不继承父链）
- Traverse 门控（无 Traverse/Write → 无任何访问）
- Write 权限隐含所有权限（除 Speak 和 Whisper）
- 根频道 Write 用户可编辑任意频道（防锁死管理员）

### 4.4 群组（Group）系统

- 每频道定义命名组（`qhGroups`）
- 组成员：`qsAdd`（显式）、`qsRemove`（移除）、`qsTemporary`（临时）
- 继承标志（`bInherit` / `bInheritable`）
- 预定义组名：`@all`、`@auth`（已认证）、`@admin`、`$<cert_hash>`
- ACL 查询响应包含完整组定义（ChanGroup proto）
- ACL 更新消息可包含组成员列表

### 4.5 临时组与权限缓存

- `setTempGroups()`：临时添加用户到组（会话期有效）
- `clearTempGroups()`：清除临时组（支持递归）
- ACL 缓存（`ACLCache`）：按用户/频道对缓存
- `clearACLCache()` 令牌更新时精确清除
- Whisper 目标缓存随 ACL 变化清除

---

## 5. 语音传输（Server.cpp、AudioReceiverBuffer.h）

### 5.1 音频分发

- `processMsg()` 处理语音包（类型/帧号/目标/载荷/位置）
- `AudioReceiverBuffer` 分别管理 UDP/TCP 接收者列表
- 同频道广播 + 链接频道广播 + 频道监听者广播
- 发送者从接收列表中排除

### 5.2 低语目标（Whisper Targets）

- 目标 ID 1-30（31 = 服务端回环）
- 支持 session 列表 / 频道（含子频道 / 链接） / 组过滤（`targetGroup`）
- `WhisperTargetCache` 缓存每 session 的语音目标
- 低语重定向（`qmWhisperRedirect`，通过 ICE `redirectWhisperGroup` 设置）

### 5.3 编解码器管理

- 支持：Opus、CELT Alpha (0.7.0)、CELT Beta (0.11.0)、Speex
- `recheckCodecVersions()` 每次用户连接/断开重新协商最优公共编解码器
- `iCodecAlpha`/`iCodecBeta` 协商结果广播 CodecVersion 消息
- `bPreferAlpha`、`bOpus` 服务端旗标
- 客户端不支持 CELT 时发送文字警告

### 5.4 加密与统计

- OCB2-AES128（每 session 独立密钥）
- good/late/lost/resync 统计计数器
- `m_rollingWindow` 滚动窗口统计（可配置）

### 5.5 带宽控制

- `BandwidthRecord`（360 槽环形缓冲）追踪带宽使用
- `addFrame(size, maxpersec)` 超出带宽时拒绝帧
- `iMaxBandwidth` 全局最大带宽（bps）

### 5.6 位置音频（Positional Audio）

- `plugin_context`（不对外广播）用于隔离语音分组
- `plugin_identity`（不对外广播）标识玩家位置
- 仅同 plugin_context 的用户互相传递位置音频

---

## 6. 消息系统（Messages.cpp:msgTextMessage）

### 6.1 文字消息路由

- 点对点（`msg.session`）
- 频道级（`msg.channel_id`）
- 树级（`msg.tree_id`）：递归向所有子频道广播（逐级检查 TextMessage 权限）
- 发送者自排除
- 发送到频道需要 `ChanACL::TextMessage` 权限

### 6.2 消息控制

- HTML 内容支持（`bAllowHTML` 配置，可关闭并服务端过滤）
- 最大文字消息长度（`iMaxTextMessageLength`）
- 最大图片消息长度（`iMaxImageMessageLength`，独立于文字限制）
- `isTextAllowed()` HTML 内容审查（XSS 防护）
- 消息过滤 ICE 信号（`textMessageFilterSig`，订阅者可静默丢弃或拒绝）

### 6.3 系统消息

- 欢迎消息（`qsWelcomeText` 或 `qsWelcomeTextFile`，在 ServerSync 中发送）
- CELT 不支持时警告文字
- ChannelListener 功能警告（客户端 < 1.4.0）
- 录音广播开始/停止通知（旧版本兼容）

### 6.4 Blob 延迟加载（RequestBlob）

- 频道描述全文按需加载（`channel_description`）
- 用户纹理/头像按需加载（`session_texture`）
- 用户评论按需加载（`session_comment`）

### 6.5 插件数据（PluginDataTransmission）

- 服务端作为中继转发插件数据
- data/dataid 长度限制
- 独立速率限制
- 发送者 session 由服务端覆盖（防伪造）

### 6.6 上下文动作（Context Actions）

- 通过 ICE `addContextCallback` 注册右键菜单项
- 上下文类型：Server（0x01）/ Channel（0x02）/ User（0x04）
- `msgContextAction` 路由到 ICE 消费者回调

---

## 7. Ban/封禁系统（Ban.h/.cpp、Messages.cpp:msgBanList、msgUserRemove）

- Ban 数据：IPv6/IPv4 地址 + 子网掩码 + 用户名 + 证书 hash + 原因 + 起始时间 + 持续时间
- 封禁同时踢出用户（`msgUserRemove` + `ban=true`）
- Ban 写入数据库持久化
- `msgBanList` 查询（需 Ban 权限）/ 替换更新整张封禁表
- `isExpired()` 自动过期检测（0=永久）
- `isValid()` 完整性验证
- 证书 hash 封禁（即使更换 IP 也可封禁）
- SuperUser（ID=0）禁止被封禁

---

## 8. 服务器配置与虚拟服务器（Meta.h、Server.h、DBWrapper.cpp）

### 8.1 Meta 全局层

- 从 `murmur.ini` 加载全局配置（`MetaParams`）
- `Meta` 单例管理所有虚拟服务器（`qhServers: QHash<unsigned int, Server*>`）
- 全局 TLS 证书/密钥（可被各虚拟服务器覆盖）
- 全局日志文件、PID 文件
- ICE endpoint 配置
- OS 信息（`qsOS` / `qsOSVersion`）

### 8.2 虚拟服务器

- 虚拟服务器按 ID 区分，独立端口（base port + serverID - 1）
- Meta 级连接频率封禁（`iBanTries` / `iBanTimeframe` / `iBanTime`）
- 每个虚拟服务器独立配置

### 8.3 服务器配置项（Server.h）

- `iMaxBandwidth`、`iMaxUsers`、`iMaxUsersPerChannel`（全局每频道上限）
- `iDefaultChan`、`bRememberChan`、`iRememberChanDuration`
- `iMaxTextMessageLength`、`iMaxImageMessageLength`
- `iOpusThreshold`（Opus 编解码切换阈值）
- `bAllowHTML`（是否允许 HTML 内容）
- `qsPassword`（服务器密码）
- `qsWelcomeText` / `qsWelcomeTextFile`（欢迎文字/文件）
- `bCertRequired`、`bForceExternalAuth`
- `qrUserName`（用户名正则）、`qrChannelName`（频道名正则）
- `iMessageLimit`/`iMessageBurst`（消息速率限制）
- `iPluginMessageLimit`/`iPluginMessageBurst`
- `broadcastListenerVolumeAdjustments`
- `m_suggestVersion`/`m_suggestPositional`/`m_suggestPushToTalk`
- `iChannelNestingLimit`、`iChannelCountLimit`
- `bBonjour`、`bAllowPing`、`allowRecording`、`rollingStatsWindow`

---

## 9. 数字证书管理（Cert.cpp、SSL.h）

- 自签名证书自动生成（`SelfSignedCertificate`）
- 私钥加载（RSA/DSA/EC，支持 PEM passphrase）
- 中间证书链（`qlIntermediates`）
- FFDHE/DH 参数（`qsdhpDHParams`）
- 客户端证书 SHA-1 hash 提取（`getDigest()`）
- 证书用于用户认证（`bVerified`/`bStrongCert`）

---

## 10. 数据库层（`database/`子目录）

- SQLite + WAL 模式
- 表：Users、Channels、ACLs、Bans、Migrations、Logs、Config（每虚拟服务器）
- ChannelGroups / GroupMembers（组成员关系）
- ChannelListeners（频道监听持久化）
- ChannelLinks（频道链接）
- UserBlobs（头像/评论 hash）
- `UserProperty`：Name/Email/Comment/Hash/Password/LastActive/KDFIterations
- `ConfigTable`：per-server 配置键值
- `LogTable`：持久化服务器操作日志
- Schema 迁移系统（版本化 DDL）

---

## 11. ICE RPC 接口（MumbleServerIce.cpp、MumbleServer.ice）

- ZeroC Ice 进程外 RPC（TCP/UDP）
- `ServerAuthenticator`：外部认证服务接口（阻塞/非阻塞）
- `ServerCallback`：服务端事件监听器（用户连接/断开/变更、文字消息等）
- 用户管理：`kickUser`、`sendMessage`、`getState`/`setState`
- 频道管理：`addChannel`/`removeChannel`、`getChannelState`/`setChannelState`
- ACL 管理：`getACL`/`setACL`
- 上下文动作注册：`addContextCallback`/`removeContextCallback`
- Whisper 重定向：`redirectWhisperGroup`
- 临时令牌：`addUserToGroup` (temporaryGroups)
- 文字消息过滤：`textMessageFilterSig`
- 可配置 ICE 端点（`icesecretread`/`icesecretwrite`）

---

## 12. Zeroconf/Bonjour 服务发现（Zeroconf.h/.cpp）

- Bonjour/mDNS 服务注册（`_mumble._tcp`）
- 本地网络自动发现支持
- 跨平台（macOS/Windows/Linux）
- 通过 `bBonjour` 配置开关

---

## 13. 公共服务器列表注册（Register.cpp）

- 向 mumble.info 公共服务器列表注册
- 注册信息：名称、密码、主机名、位置、Web 网址
- 定期心跳更新注册状态
- `qsRegName`/`qsRegPassword`/`qsRegHost`/`qsRegLocation`/`qurlRegWeb`
- `bAllowPing` 允许公共 ping 探测

---

## 14. 日志与统计（Logger.h、TracyConstants.h）

- `tracing` / Qt 二级日志
- ICE 可订阅日志事件
- 操作审计日志入库（LogTable）
- `bLogGroupChanges` / `bLogACLChanges` 详细 ACL 变更记录
- 用户统计（UserStats 消息）：加密质量、在线时长、带宽、证书、版本信息
- Tracy 性能追踪注解（`ZoneScoped`）

---

## 15. 平台与运行时（UnixMurmur.cpp、Tray.cpp、ServerApplication.cpp）

- Unix daemon 模式（fork/setsid/PID 文件）
- 系统托盘图标（Windows/macOS 桌面）
- QCoreApplication 事件循环
- SIGTERM/SIGHUP 信号处理（优雅重载配置）
