# MuNode TypeScript ↔ Rust 功能对照表

> 生成时间: 2026-03-10
> TS 文件总数: 117 (common: 21, edge-server: 48, hub-server: 48)
> Rust crate: 4 (munode-protocol, munode-common, munode-hub, munode-edge)

**标注说明:**
- ✅ Rust 已实现
- ⚠️ Rust 部分实现
- ❌ Rust 未实现

---

## 一、@munode/common 包 (21 个 TS 文件)

### 1. blob-store.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| BlobStore.init | 初始化 blob 存储目录 | ✅ Rust 在数据库初始化时创建 blobs 表 |
| BlobStore.put | 基于 SHA1 内容寻址存储 blob 数据，原子写入（临时文件+rename） | ✅ Rust 使用 SHA-256，内嵌于 SQLite |
| BlobStore.get | 按 SHA1 key 读取 blob 并验证完整性 | ✅ |
| BlobStore.exists | 检查 blob 是否存在 | ✅ 通过 put_blob 的 INSERT OR IGNORE |
| BlobStore.delete | 删除指定 blob | ❌ |
| BlobStore.getStats | 统计 blob 总数和总大小 | ❌ （Web API /api/stats 中无专项 blob 统计）|
| BlobStore 目录结构 | 使用前两位字符做子目录分片，与 Go 实现兼容 | ❌ Rust 使用数据库内嵌存储，无文件目录 |

### 2. channel-listener-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| setVolumeAdjustment | 设置用户对监听频道的音量因子（0~10.0） | ✅ |
| getVolumeAdjustment | 获取用户对某频道的音量因子，默认1.0 | ❌ |
| getAllVolumeAdjustments | 批量获取用户所有非默认音量设置 | ❌ |
| removeVolumeAdjustment | 移除单个音量调节 | ❌ |
| clearUserAdjustments | 清理断线用户的所有音量设置 | ❌ |

### 3. config/loader.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| loadConfig | 加载 .js/.cjs/.mjs/.json 格式配置文件 | ⚠️ Rust 使用 TOML 格式配置（munode-common/config.rs） |
| validateConfig | 验证必需配置字段是否存在 | ⚠️ Rust 使用 serde 反序列化时自动校验 |

### 4. connection/connection-monitor.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ConnectionMonitor.startMonitoring | 启动定期连接状态检查 | ⚠️ Rust Hub 有 health check loop（server.rs） |
| ConnectionMonitor.addConnection | 注册连接并记录类型（Hub/Edge/Peer） | ⚠️ Rust Hub 通过 edge_connections HashMap 管理 |
| ConnectionMonitor.checkConnections | 遍历所有连接检查心跳超时 | ⚠️ Rust 通过 health_check 周期性检查 |
| ConnectionMonitor.reportConnectionLost | 手动报告连接丢失 | ⚠️ Rust 通过 WebSocket 断开事件处理 |
| ConnectionMonitor.getStats | 按类型分组的连接统计 | ❌ |

### 5. crypto/ocb2-aes128.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| OCB2AES128.generateKey | 生成随机 AES-128 密钥和 IV | ✅ munode-edge/crypto.rs |
| OCB2AES128.setKey | 设置密钥和收发 IV | ✅ munode-edge/crypto.rs |
| OCB2AES128.encrypt | OCB2 模式加密，输出 [IV字节][3字节tag][密文] | ✅ munode-edge/crypto.rs |
| OCB2AES128.decrypt | OCB2 模式解密，IV 同步/乱序/丢包处理 | ✅ munode-edge/crypto.rs |
| localStats/remoteStats | 本地和远端加密统计（good/late/lost/resync） | ✅ munode-edge/crypto.rs |
| 性能优化-Cipher复用 | 缓存 Cipher/Decipher 实例避免重建 | ✅ Rust 使用 aes crate 内部优化 |
| 性能优化-预分配Buffer | 预分配工作 Buffer 减少 GC 压力 | ✅ Rust 无 GC，栈分配 |

### 6. heartbeat/heartbeat-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| startSending | 定时发送心跳包 | ⚠️ Rust Hub 使用 health check loop 替代 |
| recordHeartbeat | 记录收到的心跳时间戳 | ⚠️ Rust EdgeConnection 有 last_heartbeat |
| checkTimeout | 检查连接心跳是否超时 | ✅ Rust Hub health_check 检查超时 |
| getConnectionStatuses | 获取所有连接状态和延迟 | ❌ |

### 7. logger/logger.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| createLogger | 创建带控制台和文件传输的 winston logger | ✅ munode-common/logging.rs (tracing-subscriber) |
| setGlobalLogLevel | 运行时动态修改全局日志级别 | ⚠️ Rust 支持 env-filter 但非运行时动态 |
| 全局 Logger 注册表 | 跟踪所有 logger 实例以便批量更新级别 | ❌ |

### 8. rate-limiter.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| LeakyBucket | 漏桶速率限制算法（容量+恢复速率） | ❌ |
| LeakyBucket.ratelimit | 消耗令牌，返回是否被限制 | ❌ |
| MultiTypeRateLimiter | 多类型操作的独立速率限制 | ❌ |
| DEFAULT_RATE_LIMITS | 预设速率限制配置（消息/插件消息/命令/状态更新） | ❌ |

### 9. statistics/client-statistics.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ClientStatisticsCollector | 客户端统计数据收集器 | ❌ |
| recordUDPReceived/Sent | UDP 包统计和加密状态追踪 | ❌ |
| recordTCPReceived/Sent | TCP 包统计 | ❌ |
| recordUDPPing/TCPPing | Ping 滑动窗口计算平均值和方差 | ❌ |
| BandwidthStats | 带宽统计（上下行+峰值） | ❌ |
| VoiceStats | 语音包统计和通话时长 | ❌ |

### 10. typed-events.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| TypedEventEmitter | 类型安全的 EventEmitter 封装 | ⚠️ Rust 使用 tokio broadcast/mpsc channel 替代事件发射器 |

### 11. types/auth.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| AuthRequest/AuthResponse | 认证请求响应接口 | ✅ Rust protobuf 定义 |
| AuthStatus 枚举 | 认证状态码（Success/UserNotFound/InvalidCredentials/Banned） | ✅ munode-hub/auth_service.rs |
| CachedUser | 缓存用户接口 | ❌ Rust Hub 未用缓存层 |

### 12. types/config.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| BaseServerConfig | 基础服务器配置（serverId/name/host/port/logLevel） | ✅ munode-common/config.rs |
| TLSConfig | TLS 配置（cert/key/ca/clientCert） | ✅ munode-common/config.rs |
| ConnectionConfig | 连接配置（类型/host/port/tls/smux选项） | ⚠️ Rust 支持 WebSocket，不支持 smux |
| SmuxOptions | SMUX 多路复用选项 | ❌ |

### 13. types/tls.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| TLSOptions | 扩展TLS配置（passphrase/ciphers/版本限制） | ⚠️ Rust 使用 rustls 配置 |
| CertificateInfo | 证书详细信息（指纹/有效期/主体/颁发者） | ❌ |
| CertificateExchangeResult | 证书交换结果 | ❌ |

### 14. util/buffer-pool.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| BufferPool | Buffer 复用池，减少 GC 压力 | ❌ Rust 无 GC，不需要 |
| globalBufferPool | 全局 Buffer 池单例 | ❌ |
| warmup | 预热池预分配 Buffer | ❌ |

### 15. utils/buffer.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| readUInt16BE/readUInt32BE | 大端序读写工具函数 | ✅ Rust 标准库 u16/u32::from_be_bytes |
| writeUInt16BE/writeUInt32BE | 大端序写入 | ✅ |
| concatBuffers | Buffer 拼接 | ✅ Rust Vec::extend |

### 16. utils/varint.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| readVarint | 读取变长整数（Mumble UDP 包解析） | ❌ Rust UDP 使用固定长度头 |
| writeVarint | 写入变长整数 | ❌ |
| varintLength | 计算 varint 所需字节数 | ❌ |

---

## 二、@munode/edge-server 包 (48 个 TS 文件)

### 17. auth/auth-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleAuthenticate | 处理认证请求，验证客户端状态 | ✅ munode-edge/handler.rs (handle_authenticate) |
| handleAuthSuccess | 认证成功后：生成加密密钥、发送CryptSetup/CodecVersion/频道树/用户列表/ServerSync | ✅ munode-edge/handler.rs (LoginHandler) |
| handleAuthFailure | 发送 Reject 消息 | ✅ munode-edge/handler.rs |
| sendChannelTree | 向客户端发送完整频道树 | ✅ munode-edge/handler.rs (send_channel_tree) |
| sendUserListToClient | 向客户端发送所有在线用户状态 | ✅ munode-edge/handler.rs (send_user_states) |
| preConnect 状态支持 | 在认证前缓存 self_mute/self_deaf 等状态 | ❌ |

### 18. auth/auth-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| authenticate | 统一认证入口 | ✅ munode-edge/hub_client.rs (authenticate_user) |
| authenticateViaHub | 通过 Hub RPC 认证用户 | ✅ munode-edge/hub_client.rs |
| 客户端信息收集 | 转发 IP/版本/OS/证书信息到 Hub | ✅ |

### 19. auth/permission-checker.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleACL | ACL 查询/更新转发到 Hub | ⚠️ Rust 通过 RPC 转发但未实现完整 ACL 编辑 |
| handlePermissionQuery | 权限查询转发到 Hub | ✅ munode-edge/handler.rs (handle_permission_query) |
| refreshChannelPermissions | ACL 变更后刷新频道内用户 suppress 状态 | ❌ |
| checkPermission | 通过 Hub RPC 检查单个权限 | ✅ |
| sendPermissionDenied | 发送权限拒绝消息 | ✅ |

### 20. ban/ban-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| BanManager.checkConnection | 检查 IP/证书是否被封禁（证书缓存+LRU+CIDR匹配） | ❌ |
| BanManager.addBan | 添加封禁（IP/证书/用户，支持掩码和持续时间） | ❌ |
| BanManager.removeBan | 移除封禁 | ❌ |
| BanManager.cleanExpiredBans | 清理过期封禁 | ❌ |
| IP CIDR 匹配 | 支持 IPv4/IPv6 CIDR 子网匹配 | ❌ |

### 21. cli.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| start 命令 | 启动 Edge 服务器 | ✅ munode-edge/main.rs |
| validate-config 命令 | 验证配置文件 | ❌ |
| generate-config 命令 | 生成默认配置 | ❌ |
| 信号处理 | SIGINT/SIGTERM 优雅关闭 | ✅ |

### 22. client/client-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| createClient | 创建新客户端（session/state/索引）| ✅ munode-edge/client.rs |
| removeClient | 移除客户端并清理 socket/索引/统计 | ✅ munode-edge/state.rs |
| updateClient | 更新客户端信息，自动维护频道索引 | ✅ |
| moveClient | 移动客户端到指定频道 | ✅ |
| findClientByUsername | 按用户名查找客户端 | ✅ |
| getClientsInChannel | O(1) 频道用户索引查询 | ✅ Rust 使用 channel_users HashMap |
| channelUsersIndex | 频道-用户反向索引 | ✅ |
| listeningUsersIndex | 频道监听者反向索引 | ⚠️ Rust 支持 listening_channels 但无独立索引 |
| 速率限制集成 | 每客户端独立的多类型速率限制器 | ✅ munode-common/rate_limiter.rs + munode-edge/server.rs (TokenBucket) |
| 统计收集器集成 | 每客户端的详细数据统计 | ❌ |
| 频道监听音量管理 | 集成 ChannelListenerVolumeManager | ❌ |
| forceDisconnect | 强制断开客户端连接 | ✅ |
| broadcast | 广播消息给所有客户端 | ✅ |
| cleanupInactiveClients | 清理不活跃客户端 | ❌ |

### 23. cluster/cluster-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| joinCluster | Edge 加入 Hub 集群 | ✅ munode-edge/hub_client.rs (register) |
| handlePeerJoined | 处理新 Peer Edge 加入 | ✅ munode-edge/hub_client.rs |
| handlePeerLeft | 处理 Peer Edge 离开 | ✅ munode-edge/hub_client.rs |
| performColdRestart | 冷重启（全断开重连） | ❌ |

### 24. cluster/hub-client.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| connect | WebSocket 连接到 Hub | ✅ munode-edge/hub_client.rs |
| register | 向 Hub 注册 Edge（HMAC 认证） | ✅ |
| call | 类型安全的 RPC 调用 | ✅ |
| notify | 单向通知 Hub | ✅ |
| allocateSessionId | 从 Hub 分配全局唯一 session ID | ✅ |
| syncVoiceTarget | 同步 VoiceTarget 配置到 Hub | ⚠️ |
| relayVoiceViaTcp | TCP 降级语音中转 | ❌ |
| 连接池支持 | 多连接池化管理 | ❌ |

### 25. cluster/hub-data-sync.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| loadDataFromHub | 从 Hub 加载完整数据（频道/ACL/用户） | ✅ munode-edge/hub_client.rs (full_sync) |
| handleRemoteUserJoined | 处理远程用户加入通知 | ✅ |
| handleRemoteUserStateChanged | 处理远程用户状态变更 | ✅ |
| 选择性广播 | 根据客户端状态过滤广播内容 | ⚠️ |

### 26. cluster/hub-message-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleUserStateBroadcastFromHub | 处理 Hub 广播的用户状态更新 | ✅ munode-edge/hub_client.rs |
| handleChannelStateBroadcastFromHub | 处理 Hub 广播的频道状态更新 | ✅ |
| handleRouteTableUpdateFromHub | 处理路由表更新 | ⚠️ |
| Channel Ninja 模式过滤 | 根据 ninja 模式过滤频道可见性 | ✅（基础实现） |

### 27. cluster/reconnect-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleHubDisconnect | Hub 断连后的重连逻辑 | ⚠️ Rust hub_client 有 reconnect 但较简单 |
| performFullDisconnect | 全量断开和重新加入集群 | ❌ |
| 指数退避重试 | 指数退避重连策略 | ❌ |

### 28. config-schema.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| EdgeConfigSchema | Zod 运行时配置校验（Network/TLS/Hub/Voice/Server/Features） | ⚠️ Rust 使用 serde 反序列化验证 |
| validateAndParseEdgeConfig | 验证并解析完整 Edge 配置 | ⚠️ |

### 29. config.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| loadEdgeConfig | 加载 Edge 配置文件 | ✅ munode-common/config.rs |
| validateConfig | 验证配置有效性 | ⚠️ |

### 30. control/control-client.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| WebSocket 控制通道客户端 | 单连接或池化模式 Hub 通信 | ✅ munode-edge/hub_client.rs (WebSocket) |

### 31. control/edge-pool.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ClientConnectionPool | Hub 连接池，自动重连/轮询负载均衡/指数退避 | ❌ |

### 32. core/edge-server.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| EdgeServer.start | 启动 Edge 服务器 | ✅ munode-edge/server.rs |
| EdgeServer.stop | 停止 Edge 服务器 | ✅ |
| EdgeServer.getStats | 获取服务器统计信息 | ❌ |
| 证书哈希注册表 | 管理已知 Edge 证书哈希 | ❌ |
| 冷重启处理 | 处理集群冷重启场景 | ❌ |
| Worker 池初始化 | 初始化加密 Worker 线程池 | ❌ Rust 不需要 Worker 线程 |

### 33. core/handler-factory.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HandlerFactory | 工厂模式管理所有核心组件的创建和依赖注入 | ⚠️ Rust 使用 EdgeState 结构体集中管理 |

### 34. core/lifecycle-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| 初始化 UDP/TLS 服务器 | 启动客户端 TCP 和 Edge-to-Edge 端口 | ✅ munode-edge/server.rs + udp.rs |
| 多租户 SNI 支持 | 基于 SNI 的多虚拟主机 TLS | ❌ |
| 集群加入流程 | 启动时自动加入 Hub 集群 | ✅ |

### 35. handlers/admin-handlers.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleBanListQuery | 查询封禁列表 | ❌ |
| handleRequestBlob | 请求 blob（用户头像/评论） | ⚠️ Rust Hub 有 blob 操作 |
| handleContextAction | 处理右键菜单操作 | ❌ |
| handleUserList | 处理用户列表查询（注册用户管理） | ❌ |

### 36. handlers/connection-handlers.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleTLSConnection | TLS 连接建立，证书验证，封禁检查 | ✅ munode-edge/server.rs |
| handleUDPMessage | UDP 消息路由（地址→session 映射，NAT 穿透） | ✅ munode-edge/udp.rs |
| handleUDPPing | 处理 UDP Ping（延迟测量） | ⚠️ |

### 37. handlers/context-action.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ContextActions | 右键菜单系统（Group Shout/批量移动/Promiscuous Mode） | ❌ |
| initializeClient | 为新客户端注册可用的上下文菜单项 | ❌ |

### 38. handlers/message-handlers.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleTextMessage | 文本消息转发到 Hub | ✅ munode-edge/handler.rs |
| handlePluginData | 插件数据转发 | ⚠️ |
| sendChannelTree | 频道树广播 | ✅ |
| sendUserListToClient | 用户列表同步 | ✅ |
| broadcastUserStateToAuthenticatedClients | 广播用户状态给所有已认证客户端 | ✅ |
| Channel Ninja 过滤 | 根据 ninja 模式过滤消息 | ✅（用户列表已过滤） |
| sendPermissionDenied | 发送权限拒绝通知 | ✅ |

### 39. handlers/protocol-handlers.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleVersion | 处理 Version 消息（客户端版本协商） | ✅ munode-edge/handler.rs |
| handlePing | 处理 TCP Ping 消息和加密统计同步 | ✅ |
| handleCryptSetup | 处理 CryptSetup 重同步 | ✅ |
| handleQueryUsers | 处理用户查询 | ❌ |
| handleUserStats | 处理用户统计请求 | ❌ |
| handleVoiceTarget | 处理 VoiceTarget（耳语）配置 | ✅ |

### 40. handlers/state-handlers.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleUserState | 用户状态变更转发到 Hub | ✅ munode-edge/handler.rs |
| handleChannelState | 频道状态变更转发到 Hub | ⚠️ |
| preConnect 状态缓冲 | 未认证时缓存 UserState | ✅ munode-edge/server.rs |
| uploadUserTexture | 用户头像 blob 上传 | ✅ 通过 Hub RPC blob.setUserTexture |
| uploadUserComment | 用户评论 blob 上传 | ✅ 通过 Hub RPC blob.setUserComment |
| handleUserRemove | 用户移除（踢/禁）处理 | ⚠️ |

### 41. lifecycle/disconnect-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| （空文件占位） | 断连处理器占位 | - |

### 42. managers/ban-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleBanListQuery | 查询封禁列表 | ❌ |
| handleBanListUpdate | 更新封禁列表 | ❌ |
| checkAdminPermission | 检查管理员权限 | ❌ |

### 43. managers/event-setup-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| setupEventHandlers | 设置所有组件间事件连接（消息路由/状态变更/Hub通知/语音） | ⚠️ Rust 使用 mpsc channel 和直接调用 |

### 44. managers/message-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| parseAndHandleMessage | 解析 Mumble 协议消息（type+length+payload 帧） | ✅ munode-protocol/transport.rs |
| sendMessageToClient | 编码并发送消息给客户端 | ✅ |
| 不完整消息缓冲 | 处理 TCP 分片，缓冲不完整的消息帧 | ✅ |
| 预认证串行处理 | 未认证客户端消息串行化处理 | ❌ |

### 45. managers/voice-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| setupVoiceTransportHandlers | 设置语音传输处理器 | ✅ munode-edge/udp.rs |
| handleVoiceDataFromHub | 处理 Hub 中转的语音数据 | ⚠️ |
| updateEncryptionKey | 更新 Edge 间语音加密密钥 | ❌ |
| handleRemoteVoicePacket | 处理远程 Edge 语音包 | ⚠️ |
| TCP 降级回退 | UDP 不可用时 TCP 降级语音传输 | ❌ |

### 46. message-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| MessageHandler.handleMessage | 协议消息分发器，基于客户端状态验证消息合法性 | ✅ munode-edge/handler.rs |
| sendMessage | 编码并发送 protobuf 消息 | ✅ |
| broadcastMessage | 广播消息给多个客户端 | ✅ |

### 47. models/channel.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ChannelManager.createChannel | 创建频道 | ✅ munode-edge/channel_manager.rs |
| ChannelManager.removeChannel | 删除频道（子频道用户移动到父频道） | ✅ |
| ChannelManager.linkChannels | 频道链接管理 | ✅ |
| getAllLinkedChannels | 获取传递链接的所有频道（缓存优化） | ⚠️ |
| getAllDescendants | 获取所有后代频道（缓存优化） | ⚠️ |
| 缓存失效机制 | 频道变动自动清理链接和子孙缓存 | ❌ |

### 48. network/packet-pool.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| PacketConnPool | UDP 连接池管理（超时清理/连接复用） | ❌ |

### 49. network/udp-monitor.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| UDPMonitor | UDP 连接质量监控（ping统计/丢包率/不稳定检测） | ❌ |

### 50. relay/client-message-relay-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| relayToHub | 客户端消息中继到 Hub | ✅ Rust 通过 hub_client RPC 调用 |
| relayBatchToHub | 批量消息中继 | ❌ |

### 51. state/state-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| loadSnapshot | 从 Hub 加载状态快照 | ✅ munode-edge/state.rs |
| handleUpdate | 处理增量状态更新 | ✅ |
| addRemoteUser | 添加远程用户跟踪 | ✅ |
| removeRemoteUser | 移除远程用户跟踪 | ✅ |
| checkBan | 检查封禁状态 | ❌ |
| calculateChecksum | 计算状态校验和 | ❌ |

### 52. types.ts (Edge)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| EdgeConfig | Edge 配置类型定义 | ✅ munode-common/config.rs |
| ClientInfo/ClientState | 客户端信息和状态类型 | ✅ munode-edge/client.rs |
| AuthResult | 认证结果类型 | ✅ |
| FullSyncData | 完整同步数据类型 | ✅ |
| VoiceTargetConfig | 语音目标配置 | ✅ |
| VirtualHostContext | 多租户上下文 | ❌ |

### 53. util/geoip-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| GeoIPManager | MaxMind GeoLite2 IP 地理位置查询 | ❌ |
| isChineseIP | 判断中国 IP | ❌ |
| lookupBatch | 批量地理位置查询 | ❌ |

### 54-57. virtual-host/ (4 个文件)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| makeCompositeKey | 多租户复合键（vhost:session） | ❌ |
| CryptoKeyRegistry | 多租户加密密钥注册表 | ❌ |
| SecureContextManager | 多租户 TLS SecureContext (SNI) | ❌ |
| VirtualHostManager | 虚拟主机生命周期管理（独立 ClientManager/ChannelManager/VoiceRouter） | ❌ |

### 58-60. voice/crypto-worker-*.ts (3 个文件)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| CryptoWorkerPool | 加密 Worker 线程池（会话亲和/负载均衡/错误恢复） | ❌ Rust 不需要，已内联高效执行 |
| crypto-worker | Worker 线程实现（OCB2-AES128 操作） | ❌ |
| crypto-worker-types | Worker 消息类型定义 | ❌ |

### 61. voice/multi-tenant-voice-router.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| MultiTenantVoiceRouterSupport | 多租户语音路由（vhost 级别会话隔离） | ❌ |

### 62. voice/voice-router.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleUDPPacket | 处理 UDP 语音包（解密→路由→加密→发送） | ✅ munode-edge/udp.rs |
| handleVoiceTunnel | 处理 TCP 语音隧道 | ❌ |
| routeVoicePacket | 语音包路由（同频道/链接频道/监听者/VoiceTarget） | ✅ |
| setVoiceTarget | 设置 VoiceTarget 耳语目标 | ✅ |
| setClientCrypto | 设置客户端加密状态 | ✅ |
| 频道链接语音路由 | 链接频道间的语音转发 | ✅ |
| 监听者语音路由 | 频道监听者接收语音 | ✅ munode-edge/udp.rs get_listening_sessions |
| VoiceTarget 缓存 | 缓存 VoiceTarget 路由结果 | ❌ |

### 63. voice/voice-routing-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| VoiceRoutingManager | Edge-to-Edge 语音路由管理（路由表/质量指标/本地决策） | ⚠️ munode-edge/state.rs (peer_registry) |
| getRoute | 获取语音路由路径 | ⚠️ |
| validateRoutingTable | 路由表验证 | ❌ |

---

## 三、@munode/hub-server 包 (48 个 TS 文件)

### 64. acl-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ACLManager 缓存 | 全频道和频道级 ACL 缓存 | ✅ munode-hub/acl_manager.rs（HashMap 缓存） |
| getChannelACLs | 获取频道 ACL 列表 | ✅ |
| addACL/updateACL/deleteACL | ACL 增删改 | ⚠️ |
| refreshCache | 刷新 ACL 缓存 | ✅ |
| preloadChannelACLs | 预加载所有频道 ACL | ✅ |

### 65. auth-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| authenticate | 集中式用户认证 | ✅ munode-hub/auth_service.rs |
| authenticateWithAPI | 外部认证 API 调用 | ✅ munode-hub/auth_service.rs (HTTP webhook) |
| authenticateLocally | 本地数据库认证 | ✅ munode-hub/database.rs (Argon2) |
| 密码哈希 | SHA256 哈希（TS） vs Argon2 哈希（Rust） | ⚠️ 实现不同 |
| 认证缓存 | LRU 缓存减少外部 API 调用 | ❌ |
| cleanupExpiredCache | 清理过期缓存 | ❌ |

### 66. ban-manager.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| addBan | 添加封禁 | ⚠️ munode-hub/database.rs 有 bans 表 |
| removeBan | 移除封禁 | ⚠️ |
| checkBan | 检查封禁（证书哈希+IP双索引） | ⚠️ |
| cleanupExpiredBans | 清理过期封禁 | ❌ |

### 67. certificate-exchange.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| registerCertificate | 注册 Edge 证书 | ❌ |
| exchangeCertificates | Edge 间证书交换 | ❌ |
| validateCertificate | 证书验证（node-forge） | ❌ |

### 68. channel-group-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| getChannelGroups | 获取频道组列表 | ❌ |
| createChannelGroup | 创建频道组 | ❌ |
| updateChannelGroup | 更新频道组 | ❌ |
| getChannelGroupMembers | 获取频道组成员 | ❌ |

### 69. channel-manager.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| createChannel | 创建频道并持久化 | ✅ munode-hub/channel_store.rs + database.rs |
| updateChannel | 更新频道属性 | ✅ |
| deleteChannel | 删除频道 | ✅ |
| getChannel/getAllChannels | 查询频道 | ✅ |
| linkChannels/unlinkChannels | 频道链接管理 | ✅ |
| getChildChannels | 获取子频道列表 | ✅ |

### 70. cli.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| 启动入口 | 命令行启动和优雅关闭 | ✅ munode-hub/main.rs |

### 71. config-defaults.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| CONFIG_DEFAULTS | 对齐 Murmur 官方默认配置值 | ⚠️ Rust 有 Option 默认值 |
| applyConfigDefaults | 应用默认配置 | ⚠️ |

### 72. config-schema.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubConfigSchema | Zod 配置校验 | ⚠️ Rust serde 反序列化 |
| validateAndParseHubConfig | 验证并解析 Hub 配置 | ⚠️ |

### 73. config-validator.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| validateHubConfig | 运行时配置验证（端口/权限/TLS/DB） | ❌ |

### 74. control-service.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubControlService | Hub 控制平面 RPC 服务（25+ 处理器注册） | ✅ munode-hub/rpc_handler.rs |
| broadcast | 广播消息到所有 Edge | ✅ |
| broadcastExcept | 广播除指定 Edge 外 | ✅ |

### 75. control/control-server.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ControlChannelServer | WebSocket 控制服务器 | ✅ munode-hub/server.rs |
| handleConnection | 处理 Edge WebSocket 连接 | ✅ |
| registerEdge | 注册 Edge 到连接管理 | ✅ |

### 76. control/edge-join-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| EdgeJoinManager | 序列化 Edge 加入请求（令牌队列锁定） | ❌ |

### 77. control/edge-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| EdgeManager | Edge 连接状态跟踪和消息缓存 | ⚠️ munode-hub/server.rs (edge_connections) |

### 78. control/hub-pool.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ServerConnectionManager | 服务端连接池（每 Edge 多连接） | ❌ |
| VirtualEdgeChannel | 虚拟 Edge 通信通道抽象 | ❌ |

### 79. control/message-cache.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| MessageCache | 断连 Edge 消息缓存（FIFO 驱逐/TTL 清理） | ❌ |

### 80. database-operations.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| DatabaseOperations | 数据库和 blob 操作的外观抽象 | ⚠️ Rust 直接调用 database.rs |

### 81. database-worker-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| DatabaseWorkerManager | SQLite Worker 线程管理（超时保护） | ❌ Rust 使用 tokio 异步 |

### 82. database-worker.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| Worker 线程入口 | Node.js 22+ DatabaseSync，100 条语句 LRU 缓存 | ❌ |

### 83. database.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubDatabase | SQLite 数据库（1500+ 行） | ✅ munode-hub/database.rs |
| 表结构 | 13 个表（users/channels/acls/bans 等） | ⚠️ Rust 5 个表（users/channels/channel_links/acls/bans） |
| 审计日志 | 审计日志表 | ❌ |
| 备份 | VACUUM INTO（30 天保留） | ❌ |
| pragma 优化 | WAL 模式、缓存大小、同步级别 | ✅ Rust 也使用 WAL |
| 迁移系统 | 数据库版本迁移 | ❌ |

### 84. factory.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubHandlerFactory | 单例工厂（20+ 服务初始化） | ⚠️ Rust 使用 HubState 结构体 |

### 85. handlers/acl-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleACLRequest | ACL 查询/更新（权限检查/自动授予） | ⚠️ munode-hub/rpc_handler.rs |
| handlePermissionQueryRequest | 权限查询 | ✅ |
| Ninja 组支持 | Ninja 模式 ACL 处理 | ❌ |

### 86. handlers/admin-operation-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleAdminOperation | 管理操作（清理/统计） | ❌ |

### 87. handlers/authentication-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleAllocateSessionId | 分配全局 session ID | ✅ munode-hub/session_manager.rs |
| handleAuthenticateUser | 用户认证（最后频道恢复） | ✅ munode-hub/rpc_handler.rs |
| broadcastUserJoined | 广播用户加入通知 | ✅ |
| Ninja 过滤 | Ninja 模式用户过滤 | ❌ |

### 88. handlers/blob-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleBlobPut | 存储 blob（纹理/评论） | ⚠️ munode-hub/rpc_handler.rs |
| handleBlobGet | 获取 blob | ⚠️ |
| handleGetUserTexture | 获取用户头像 | ⚠️ |
| handleSetUserTexture | 设置用户头像并广播 | ⚠️ |

### 89. handlers/certificate-exchange-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleExchangeCertificates | 证书交换处理 | ❌ |

### 90. handlers/channel-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleSaveChannel | 频道创建/更新操作 | ✅ |

### 91. handlers/channel-state-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleChannelStateNotification | 频道状态（创建/更新/删除/链接），权限矩阵 | ⚠️ |
| handleChannelRemoveNotification | 频道删除通知 | ⚠️ |
| Ninja 支持 | Ninja 模式频道过滤 | ❌ |

### 92. handlers/cluster-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleEdgeJoin | Edge 加入集群 | ✅ munode-hub/rpc_handler.rs |
| handleEdgeJoinComplete | Edge 加入完成确认 | ❌ |
| handleEdgeReportQuality | Edge 质量上报 | ❌ |

### 93. handlers/notification-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleUserRemoveNotification | 用户移除（踢/禁）+ 权限矩阵 | ⚠️ |
| handleUserStatsNotification | 用户统计请求 | ❌ |
| performArbitration | 断开仲裁 | ❌ |

### 94. handlers/sync-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleFullSync | 完整同步（频道/ACL/会话/Edge） | ✅ munode-hub/rpc_handler.rs (edge_full_sync) |
| handleGetChannels | 获取频道列表 | ✅ |
| handleGetACLs | 获取 ACL 列表 | ✅ |
| Ninja 过滤 | Ninja 模式同步过滤 | ❌ |

### 95. handlers/text-message-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleTextMessageNotification | 文本消息路由（用户/频道/树），多目标+权限检查 | ✅ munode-hub/rpc_handler.rs |

### 96. handlers/user-state-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleUserStateNotification | 用户状态变更（移动/mute/deaf/suppress） | ✅ munode-hub/rpc_handler.rs |
| handleUserLeftNotification | 用户离开通知 | ✅ |
| 临时令牌处理 | 临时访问令牌权限管理 | ❌ |
| Ninja 逻辑 | Ninja 模式用户状态处理 | ❌ |

### 97. handlers/voice-routing-handler.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| handleSyncVoiceTarget | 语音目标同步 | ⚠️ |
| handleGetVoiceTargets | 获取语音目标配置 | ⚠️ |
| handleRelayVoiceViaTcp | TCP 降级语音中转 | ❌ |

### 98. hub-server.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubServer.init | Hub 初始化（数据库/管理器/服务） | ✅ munode-hub/server.rs |
| HubServer.start | 启动 WebSocket/Web API | ✅ |
| HubServer.stop | 停止服务器 | ✅ |
| registerEdgeVoiceEndpoint | 注册 Edge 语音端点 | ⚠️ |
| Web API 服务 | HTTP REST API | ✅ /api/status, /api/edges, /api/stats, /api/topology, /api/health |

### 99. network-topology-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| NetworkTopologyManager | 网络拓扑管理（Dijkstra 路由） | ✅ munode-hub/topology_manager.rs |
| 路由表推送 | 推送路由表到 Edge | ⚠️ |
| 连接质量验证 | RTT/丢包/抖动质量指标 | ⚠️ |
| 缓存/统计 | 路由缓存和详细统计 | ❌ |

### 100. permission-checker.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| HubPermissionChecker | 完整权限检查系统 | ✅ munode-hub/acl_manager.rs |
| 继承链权限计算 | 从根到目标频道的 ACL 遍历 | ✅ |
| 组成员资格 | 基于组的权限 | ✅ |
| 临时令牌权限 | 临时访问令牌 | ❌ |
| Ninja 过滤权限 | Ninja 模式特殊权限处理 | ❌ |
| 权限缓存 | (user_id, channel_id) 缓存 | ✅ |

### 101. permission-worker-manager.ts + permission-worker.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| PermissionWorkerManager | 权限计算 Worker 线程池 | ❌ Rust 不需要，直接异步计算 |
| calculateBulkEnterPermissions | 批量频道进入权限计算 | ❌ |

### 102. registry.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ServiceRegistry | Edge 注册/心跳/HMAC 认证 | ✅ munode-hub/server.rs |

### 103. relay/client-message-router.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| ClientMessageRouter | 客户端消息路由（单播/多播/频道/全局广播） | ✅ munode-hub/rpc_handler.rs |

### 104. session-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| allocateSessionId | 全局 session ID 分配 | ✅ munode-hub/session_manager.rs |
| reportSession | 上报会话信息 | ✅ |
| updateSessionChannel | 更新会话频道 | ✅ |
| updateSessionState | 更新会话状态（mute/deaf/suppress） | ✅ |
| removeSession | 移除会话 | ✅ |

### 105. types.ts (Hub)
| 子功能点 | 描述 | Rust |
|---------|------|------|
| Hub 类型定义 | 配置/Edge 信息/连接状态/VoiceTarget | ✅ |

### 106. utils/channel-utils.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| getChannelId | 处理 channel_id 字段过渡 | ❌ |

### 107. voice-encryption-manager.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| VoiceEncryptionManager | Edge 间语音加密密钥管理（生成/轮换/分配） | ❌ |

### 108. voice-target-sync.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| VoiceTargetSyncService | VoiceTarget 配置同步（完整+增量更新） | ⚠️ |

### 109. web-api-service.ts
| 子功能点 | 描述 | Rust |
|---------|------|------|
| WebApiService | HTTP REST API 服务（8+ 端点） | ❌ |
| /api/status | 服务器状态端点 | ❌ |
| /api/edges | Edge 列表端点 | ❌ |
| /api/topology | 拓扑信息端点 | ❌ |
| /api/health | 健康检查端点 | ❌ |

---

## 四、统计摘要

### 按包统计

| 包 | 总子功能点 | ✅ 已实现 | ⚠️ 部分实现 | ❌ 未实现 |
|---|-----------|---------|------------|---------|
| @munode/common | 51 | 14 | 10 | 27 |
| @munode/edge-server | 127 | 45 | 20 | 62 |
| @munode/hub-server | 100 | 41 | 22 | 37 |
| **合计** | **278** | **100 (36%)** | **52 (19%)** | **126 (45%)** |

### 按功能域统计

| 功能域 | ✅ | ⚠️ | ❌ | 说明 |
|--------|---|---|---|------|
| **核心协议处理** | 高 | 低 | 低 | 消息编解码、帧处理已完成 |
| **认证系统** | 高 | 中 | 低 | 支持多方式认证，Rust 用 Argon2+Lua |
| **频道管理** | 高 | 低 | 低 | 基本 CRUD 和链接已实现 |
| **权限系统 (ACL)** | 高 | 中 | 低 | ACL 继承链和权限计算已实现 |
| **语音路由** | 高 | 中 | 中 | 基础路由完成，TCP 降级/Worker 池未实现 |
| **加密 (OCB2)** | 高 | 低 | 低 | 核心加解密完成 |
| **Hub-Edge 通信** | 高 | 中 | 低 | WebSocket RPC 完成，连接池未实现 |
| **会话管理** | 高 | 低 | 低 | 全局 session 管理完成 |
| **数据库** | 中 | 中 | 中 | 基础表完成，审计/备份/迁移未实现 |
| **封禁系统** | 中 | 中 | 中 | Hub 自动封禁已实现（FailedAuthTracker），Edge 端检查待完善 |
| **多租户** | 低 | 低 | 高 | 完全未实现 |
| **Channel Ninja** | 低 | 低 | 高 | ✅ 基础实现（Hub 配置 + Edge 过滤） |
| **监控/统计** | 低 | 低 | 高 | 客户端统计、UDP 监控等未实现 |
| **速率限制** | 中 | 低 | 中 | 令牌桶速率限制器已实现（文本消息），多类型限制待完善 |
| **Web API** | 低 | 低 | 高 | ✅ 已实现核心端点（status/edges/stats/topology/health） |
| **GeoIP** | 低 | 低 | 高 | 完全未实现 |
| **连接池/重连** | 低 | 中 | 高 | 基本重连有，高级池化未实现 |
| **Blob 存储** | 低 | 中 | 高 | ✅ 内嵌于 SQLite，支持用户头像/评论，内容寻址去重 |

### Rust 特有功能（TS 未实现）

| 功能 | 位置 | 说明 |
|------|------|------|
| Lua 认证脚本引擎 | munode-hub/lua_auth.rs | 嵌入 Lua 5.4 VM 做认证逻辑 |
| Argon2 密码哈希 | munode-hub/database.rs | TS 使用 SHA256，Rust 更安全 |
| Edge-to-Edge 直接 UDP | munode-edge/udp.rs | 专用 UDP 端口做 Edge 间直传 |

---

## 五、注意事项

1. **Rust 不需要的 TS 功能**：Buffer Pool、Worker 线程池（加密/数据库/权限）— Rust 无 GC 且原生高效，不需要这些 Node.js 特有的优化手段
2. **架构差异**：TS 使用 EventEmitter + 事件驱动，Rust 使用 tokio channel + async/await
3. **配置格式**：TS 使用 JS/JSON + Zod 校验，Rust 使用 TOML + serde
4. **密码哈希**：TS 使用 SHA256，Rust 使用 Argon2（更安全）
5. **多租户/Channel Ninja**：这是 TS 实现的高级特性，Rust 完全未涉及
