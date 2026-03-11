# Rust TOML 配置说明

本文档说明 Rust 版本 MuNode 的 TOML 配置文件格式和选项。

## 与 TypeScript 版本的对比

Rust 版本使用 TOML 格式配置，相比 TypeScript 版本的 JavaScript 配置更简洁，专注于核心功能。

### Hub Server 配置对照表

| 配置项 | TypeScript (JS) | Rust (TOML) | 说明 |
|--------|----------------|-------------|------|
| **基本信息** |
| server_id | ✅ | ❌ | 服务器 ID |
| name | ✅ | ❌ | 服务器名称 |  
| register_name | ✅ | ❌ | 显示名称 |
| **网络** |
| host | ✅ | ✅ | 监听地址 |
| port | ✅ | ❌ | 主服务端口 |
| control_port | ✅ | ✅ | 控制端口（Edge 连接） |
| **TLS** |
| tls.cert, key, ca | ✅ | ❌ | TLS 证书配置 |
| tls.require_client_cert | ✅ | ❌ | 要求客户端证书 |
| **数据库** |
| database.path | ✅ | ✅ | 数据库路径 |
| database.backup_dir | ✅ | ❌ | 备份目录 |
| database.wal_mode | ✅ | ❌ | WAL 模式 |
| **Blob 存储** |
| blob_store.path | ✅ | ✅ | Blob 文件存储目录（默认 `data/blobs`），以 hash 前两位为子目录分片 |
| **注册表** |
| registry.hmac_secret | ✅ | ✅ | HMAC 密钥 |
| registry.heartbeat_timeout | ✅ | ✅ | 心跳超时 |
| registry.max_edges | ✅ | ❌ | 最大 Edge 数 |
| **Web API** |
| web_api.enabled | ✅ | ✅ | 启用 Web API |
| web_api.port | ✅ | ✅ | API 端口 |
| web_api.host | ✅ | ✅ | API 监听地址 |
| **认证** |
| auth.allow_guest | ✅ | ✅ | 允许游客 |
| auth.default_channel | ✅ | ✅ | 默认频道 |
| auth.welcome_text | ✅ | ✅ | 欢迎消息 |
| auth.server_password | ✅ | ✅ | 服务器密码 |
| auth.require_auth_service | ✅ | ✅ | 强制外部认证 |
| auth.lua_script | ❌ | ✅ | Lua 认证脚本 |
| auth.http_url | ✅ | ✅ | HTTP 认证 URL |
| auth.http_timeout_ms | ✅ | ✅ | HTTP 超时 |
| auth.callback | ✅ | ❌ | JS 回调函数 |
| **服务器限制** |
| timeout | ✅ | ❌ | 客户端超时 |
| max_users | ✅ | ❌ | 最大用户数 |
| max_users_per_channel | ✅ | ❌ | 每频道最大用户数 |
| channel_nesting_limit | ✅ | ❌ | 频道嵌套限制 |
| channel_count_limit | ✅ | ❌ | 频道数量限制 |
| **带宽和消息** |
| bandwidth | ✅ | ❌ | 带宽限制 |
| text_message_length | ✅ | ✅ | 文本消息长度（`limits.text_message_length` / `server.text_message_length`） |
| image_message_length | ✅ | ✅ | 图片消息长度（`limits.image_message_length` / `server.image_message_length`） |
| message_limit | ✅ | ✅ | 消息速率限制（`limits.message_rate`/`message_burst` / `server.message_rate`/`message_burst`） |
| plugin_message_limit | ✅ | ❌ | 插件消息限制 |
| **安全** |
| kdf_iterations | ✅ | ❌ | KDF 迭代次数 |
| allow_html | ✅ | ❌ | 允许 HTML |
| cert_required | ✅ | ❌ | 要求证书 |
| force_external_auth | ✅ | ❌ | 强制外部认证 |
| **验证规则** |
| username_regex | ✅ | ✅ | 用户名正则（`validation.username_regex`） |
| channel_name_regex | ✅ | ✅ | 频道名正则（`validation.channel_name_regex`） |
| **自动封禁** |
| auto_ban.enabled | ✅ | ✅ | 启用自动封禁 |
| auto_ban.attempts | ✅ | ✅ | 触发封禁的失败次数（`auto_ban.attempts`） |
| auto_ban.time_window | ✅ | ✅ | 计数时间窗口（秒，`auto_ban.time_window`） |
| auto_ban.duration | ✅ | ✅ | 封禁时长（秒，`auto_ban.duration`，0=永久） |
| **频道行为** |
| remember_channel | ✅ | ✅ | 记住频道（始终启用，不可配置） |
| remember_channel_duration | ✅ | ❌ | 记忆时长（暂未支持过期） |
| **客户端建议** |
| suggest.version | ✅ | ✅ | 建议版本（数字，如 1340029，`suggest.version`） |
| suggest.positional | ✅ | ✅ | 建议位置音频（`suggest.positional`） |
| suggest.push_to_talk | ✅ | ✅ | 建议 PTT（`suggest.push_to_talk`） |
| **服务器注册** |
| register_password | ✅ | ❌ | 注册密码 |
| register_hostname | ✅ | ❌ | 注册主机名 |
| bonjour | ✅ | ❌ | 本地发现 |
| **高级功能** |
| listeners_per_channel | ✅ | ❌ | 频道监听者限制 |
| allow_recording | ✅ | ❌ | 允许录音 |
| channel_ninja | ✅ | ❌ | 隐身频道 |
| send_version | ✅ | ❌ | 发送版本 |
| allow_ping | ✅ | ❌ | 允许 ping |
| **日志** |
| log_level | ✅ | ✅ | 日志级别 |
| log_file | ✅ | ❌ | 日志文件 |
| log_days | ✅ | ❌ | 日志保留天数 |
| **语音路由策略** |
| voice_routing.enable_relay | ✅ | ✅ | Hub 侧允许中继语音（默认 true） |
| voice_routing.relay_cost_factor | ✅ | ✅ | 中继路由代价系数（默认 1.2） |
| voice_routing.direct_rtt_threshold | ✅ | ✅ | 直连 RTT 阈值 ms（默认 200） |
| voice_routing.direct_loss_threshold | ✅ | ✅ | 直连丢包阈值 0-1（默认 0.05） |
| voice_routing.max_relay_streams_per_pair | ✅ | ✅ | 每对 Edge 最大中继流数（0=无限制） |
| voice_routing.max_total_relay_streams | ✅ | ✅ | Hub 总最大中继流数（0=无限制） |

### Edge Server 配置对照表

| 配置项 | TypeScript (JS) | Rust (TOML) | 说明 |
|--------|----------------|-------------|------|
| **基本信息** |
| server_id | ✅ | ✅ | 服务器 ID（必须唯一） |
| name | ✅ | ✅ | 服务器名称 |
| mode | ✅ | ❌ | 集群模式 |
| **网络** |
| network.host | ✅ | ✅ | 监听地址 |
| network.port | ✅ | ✅ | 客户端端口 |
| network.edge_port | ✅ | ✅ | Edge 间端口 |
| network.external_host | ✅ | ✅ | 外部地址 |
| network.external_port | ✅ | ✅ | 外部端口 |
| network.external_edge_port | ✅ | ❌ | 外部 Edge 端口 |
| network.region | ✅ | ✅ | 地理区域 |
| **TLS** |
| tls.cert | ✅ | ✅ | 服务器证书 |
| tls.key | ✅ | ✅ | 私钥 |
| tls.ca | ✅ | ✅ | CA 证书 |
| tls.edge_cert | ✅ | ❌ | Edge 间客户端证书 |
| tls.edge_key | ✅ | ❌ | Edge 间私钥 |
| **Hub 连接** |
| hub_server.host | ✅ | ✅ | Hub 地址 |
| hub_server.port | ✅ | ❌ | Hub 主端口 |
| hub_server.control_port | ✅ | ✅ | Hub 控制端口 |
| hub_server.reconnect_interval | ✅ | ✅ | 重连间隔 |
| hub_server.heartbeat_interval | ✅ | ✅ | 心跳间隔 |
| hub_server.hmac_secret | ✅ | ✅ | HMAC 密钥 |
| hub_server.pool_size | ✅ | ✅ | 连接池大小（默认 1 = 单连接，>1 = 多连接轮询） |
| hub_server.tls.* | ✅ | ❌ | Hub TLS 配置 |
| **服务器配置** |
| server.capacity | ✅ | ✅ | 最大用户数 |
| server.max_bandwidth | ✅ | ✅ | 最大带宽 |
| server.default_channel | ✅ | ✅ | 默认频道 |
| server.welcome_text | ✅ | ✅ | 欢迎消息 |
| server.disable_hub_relay | ✅ | ✅ | 禁用 Hub 中转 |
| server.listeners_per_user | ✅ | ✅ | 每用户最大监听频道数（0=无限制） |
| server.listeners_per_channel | ✅ | ✅ | 每频道最大监听者数（0=无限制） |
| **语音路由** |
| voice_routing.enabled | ✅ | ✅ | 启用语音路由（默认 true） |
| voice_routing.connection_strategy | ✅ | ✅ | 连接策略：`auto_fallback`（默认）/`tcp_only`/`direct_only` |
| voice_routing.fallback.enable_tcp_fallback | ✅ | ✅ | 启用 UDP 质量降级时切换 TCP（默认 false） |
| voice_routing.fallback.tcp_fallback_delay | ✅ | ✅ | 切换 TCP 延迟（ms，默认 2000） |
| voice_routing.relay.enabled | ✅ | ✅ | 允许本 Edge 作为中继节点（默认 true） |
| voice_routing.relay.max_relay_bandwidth | ✅ | ✅ | 最大中继带宽 Kbps（默认 10000） |
| voice_routing.shared_secret | ✅ | ❌ | 共享密钥（TS 专有） |
| voice_routing.local_decision.* | ✅ | ❌ | 本地决策配置（TS 专有） |
| **客户端建议** |
| client.suggest_version | ✅ | ❌ | 建议版本 |
| client.suggest_positional | ✅ | ❌ | 建议位置音频 |
| client.suggest_push_to_talk | ✅ | ❌ | 建议 PTT |
| **功能开关** |
| features.geoip | ✅ | ❌ | GeoIP 功能 |
| features.allow_ping | ✅ | ❌ | 允许 ping |
| **日志** |
| log_level | ✅ | ✅ | 日志级别 |
| log_file | ✅ | ❌ | 日志文件 |

## Rust 版本的设计理念

### 简化配置

Rust 版本有意简化配置选项，主要原因：

1. **核心功能优先** - 专注于实现 Mumble 协议核心功能
2. **合理默认值** - 很多 TypeScript 版本的配置在 Rust 中有合理的默认实现
3. **减少复杂性** - 避免过度配置导致的混乱
4. **类型安全** - TOML 提供更好的类型检查

### 硬编码的值

以下值在 Rust 版本中是硬编码的：

- 带宽限制：558000 bps
- 消息长度限制：根据协议规范
- 超时值：标准默认值

### 未实现的功能

某些 TypeScript 功能在 Rust 版本中尚未实现：

1. **服务器注册** - 公共服务器列表注册
2. **高级 ACL 功能** - channnel_ninja 等
3. **详细的语音路由配置** - 完整的路由策略配置

以下功能已在 Rust 版本中实现（但与 TypeScript 实现方式不同）：

- **Web API** - 已实现 `/api/status`、`/api/edges`、`/api/stats`、`/api/topology`、`/api/health` 端点
- **Blob 存储** - 已实现，直接内嵌于 SQLite 数据库（使用 SHA-256 内容寻址）

## 配置最佳实践

### Hub Server

```toml
[network]
control_port = 8443              # 标准控制端口

[database]
path = "./data/hub.sqlite"       # 确保目录可写

[blob_store]
path = "./data/blobs"            # Blob 文件目录，以 hash 前两位为子目录分片

[registry]
hmac_secret = "CHANGE-ME-RANDOM-64-CHAR-STRING"  # 使用强密钥
heartbeat_timeout = 90000        # 3 次心跳间隔

[auth]
allow_guest = false              # 生产环境建议禁用
lua_script = '''                 # 推荐使用 Lua 脚本
function authenticate(req)
  -- 调用你的认证系统
end
'''

# 消息限制配置（可选，有默认值）
[limits]
text_message_length = 5000       # 最大文本消息长度（字节）
image_message_length = 131072    # 最大图片消息长度（字节，128KB）
message_rate = 10.0              # 每用户每秒最大消息数（令牌桶速率）
message_burst = 5                # 令牌桶突发容量

# 自动封禁配置（可选）
[auto_ban]
enabled = true                   # 开启自动封禁
attempts = 10                    # 触发封禁的失败次数
time_window = 120                # 计数窗口（秒）
duration = 300                   # 封禁时长（秒，0=永久）

# 验证规则配置（可选）
# 使用 Rust regex 语法，参考 https://docs.rs/regex
[validation]
# 用户名必须以字母开头，只能包含字母、数字和下划线，长度 2-30
username_regex = '^[a-zA-Z][a-zA-Z0-9_]{1,29}$'
# 频道名必须以字母或数字开头，只能包含字母、数字、空格、下划线和连字符，长度 1-60
channel_name_regex = '^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,59}$'

log_level = "info"               # 生产环境使用 info
```

### Edge Server

```toml
server_id = 1                    # 集群中必须唯一
name = "Edge Server 1"

[network]
port = 64738                     # Mumble 标准端口
edge_port = 64739               # Edge 间通信端口
external_host = "edge.example.com"  # 公网地址
region = "asia-east"            # 地理区域

[tls]
cert = "./certs/edge-cert.pem"   # 正式证书
key = "./certs/edge-key.pem"

[hub_server]
host = "hub"                     # Docker: 使用服务名
control_port = 8443
hmac_secret = "SAME-AS-HUB"     # 必须与 Hub 匹配
# pool_size = 2                  # 可选：多连接轮询提高可靠性（默认 1）

[server]
capacity = 1000                  # 根据资源调整
max_bandwidth = 558000           # 标准带宽
text_message_length = 5000       # 最大文本消息长度（字节，默认 5000）
image_message_length = 131072    # 最大图片消息长度（字节，默认 131072）
message_rate = 10.0              # 每用户每秒消息速率（默认 10.0）
message_burst = 5                # 令牌桶突发容量（默认 5）

# 客户端建议配置（可选）
[suggest]
# version = 1340029              # 建议客户端版本（数字格式，如 1.3.0.29 → 1340029）
# positional = true              # 建议启用位置音频
# push_to_talk = false           # 建议关闭 PTT（启用语音激活）

# Web API 配置（可选）
[web_api]
enabled = false                  # 是否启用 HTTP Web API
host = "0.0.0.0"                 # 监听地址
port = 8080                      # 监听端口
# 启用后可访问：
# GET /api/health  — 健康探针
# GET /api/status  — Hub 状态
# GET /api/stats   — Hub 统计数据
# GET /api/edges   — Edge 列表
# GET /api/topology — 网络拓扑
# GET /metrics     — Prometheus metrics（文本格式）

log_level = "info"
```

## Docker Compose 配置要点

### Hub

- `database.path` 相对于容器内 `/app/`
- Edge 通过 `hub:8443` 连接（容器网络）
- 确保 `./data` 目录挂载为 volume

### Edge

- `hub_server.host = "hub"` （容器服务名）
- `external_host` 设置为公网 IP/域名
- TLS 证书挂载到 `/app/certs/`
- `server_id` 在集群中必须唯一

## 迁移指南

从 TypeScript 版本迁移到 Rust 版本：

1. **复制必需配置**：
   - server_id, name
   - network 配置
   - TLS 证书路径
   - Hub 连接信息

2. **简化认证配置**：
   - TypeScript callback → Rust Lua script
   - 或使用 HTTP webhook

3. **调整默认值**：
   - 检查 Rust 的默认值是否满足需求
   - 大多数默认值已经优化

4. **移除不支持的配置**：
   - 删除 Rust 不支持的配置项
   - 参考上面的对照表

5. **测试连接**：
   - 先测试 Hub-Edge 连接
   - 再测试客户端连接
   - 验证认证流程

## 常见问题

### Q: 为什么 Rust 版本配置项这么少？

A: Rust 版本专注于核心功能，很多 TypeScript 的配置在 Rust 中使用了合理的默认值或标准实现。

### Q: 会添加更多配置项吗？

A: 可能会，但会谨慎评估每个配置项的必要性，避免过度配置。

### Q: 如何实现 TypeScript 的某个特性？

A: 可以通过以下方式：
- Lua 脚本（认证逻辑）
- 外部服务（Web API）
- 代码扩展（提交 PR）

### Q: TOML 支持注释吗？

A: 支持，使用 `#` 开头的行注释。

### Q: 可以使用 JSON 配置吗？

A: 可以，使用 `.json` 扩展名，配置项相同。

## 参考资料

- [TOML 规范](https://toml.io/)
- [Mumble 协议文档](https://mumble-protocol.readthedocs.io/)
- [MuNode 架构文档](../../docs/)
