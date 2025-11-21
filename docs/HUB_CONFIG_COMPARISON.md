# Hub 配置项对比与实现建议

## 概述

本文档对比 Mumble 官方服务器 (Murmur) 的配置项与 MuNode Hub Server 的配置实现，列出缺失的配置项，并提供实现建议。

## 配置项对比

### 1. 基础网络配置

#### 已实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| host | `host` | `host` | 绑定地址 |
| port | `port` | `port` | 监听端口 |
| timeout | `timeout` | ❌ | 客户端超时 |
| serverpassword | `serverpassword` | ❌ | 服务器密码 |

#### 未实现但重要 ⚠️

| Murmur 配置 | 当前状态 | 优先级 | 建议 |
|-----------|---------|--------|------|
| `timeout` | 未实现 | **高** | 应实现客户端超时配置（默认30秒） |
| `serverpassword` | 未实现 | 中 | 服务器级别密码保护 |

### 2. 用户与频道限制

#### 已实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| registerName | `registerName` | `registerName` | 公开服务器名称 |

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `users` | 最大用户数 | **高** | 默认1000，应该实现 |
| `usersperchannel` | 每频道最大用户数 | 中 | 默认0（无限制） |
| `listenersperchannel` | 每频道最大监听者数 | 低 | 用于 Listen Channel 功能 |
| `listenersperuser` | 每用户最大监听代理数 | 低 | Listen Channel 功能相关 |
| `channelnestinglimit` | 频道嵌套深度限制 | **高** | 默认10，防止无限嵌套 |
| `channelcountlimit` | 频道总数限制 | **高** | 默认1000，防止滥用 |

### 3. 带宽与消息限制

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `bandwidth` | 每用户最大带宽 (bps) | **高** | 默认558000，防止带宽滥用 |
| `textmessagelength` | 文本消息最大长度 | **高** | 默认5000字符 |
| `imagemessagelength` | 图片消息最大长度 | 中 | 默认131072字节 |
| `messagelimit` | 消息速率限制（消息/秒） | **高** | 默认1，防止消息泛洪 |
| `messageburst` | 消息突发容量 | **高** | 默认5，令牌桶算法 |
| `pluginmessagelimit` | 插件消息速率限制 | 中 | 默认4 |
| `pluginmessageburst` | 插件消息突发容量 | 中 | 默认15 |

### 4. 认证与安全

#### 已实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| cert | `certificate` | `tls.cert` | TLS 证书 |
| key | `key` | `tls.key` | TLS 私钥 |
| ca | - | `tls.ca` | CA 证书 |
| certrequired | `certrequired` | `tls.requireClientCert` | 要求客户端证书 |

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `legacypasswordhash` | 使用旧式 SHA1 密码哈希 | 低 | 默认false，使用 PBKDF2 | 不实现
| `kdfiterations` | PBKDF2 迭代次数 | **高** | 默认-1（自动基准测试），安全必需 |
| `forceExternalAuth` | 强制外部认证 | 中 | 集成外部认证系统时需要 |
| `sslCiphers` | SSL 加密套件配置 | 中 | 增强安全性 |
| `sslDHParams` | Diffie-Hellman 参数 | 低 | 现代 TLS 已不常用 | 不实现

### 5. 欢迎消息与版本建议

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `welcometext` | 欢迎消息文本 | 中 | 用户连接时显示 |
| `welcometextfile` | 欢迎消息文件路径 | 中 | 从文件加载欢迎消息 |
| `suggestversion` | 建议客户端版本 | 低 | 格式: major.minor.patch |
| `suggestpositional` | 建议启用位置音频 | 低 | true/false/未设置 |
| `suggestpushtotalk` | 建议使用按键说话 | 低 | true/false/未设置 |

### 6. 频道行为

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `defaultchannel` | 默认频道 ID | 中 | 默认0（Root） |
| `rememberchannel` | 记住用户上次频道 | 中 | 默认true |
| `rememberchannelduration` | 记住频道的时长（秒） | 中 | 默认0（永久），设置后会过期 |
| `allowhtml` | 允许 HTML 消息 | **高** | 默认true，安全考虑 |

### 7. HTML 与内容过滤

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `allowhtml` | 允许 HTML 消息 | **高** | 必须实现 HTML 过滤以防 XSS |

**说明**: Murmur 有内置的 HTML 过滤器来防止恶意 HTML 注入。如果启用 HTML，必须实现严格的白名单过滤。

### 8. 用户名与频道名验证

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `username` | 用户名正则表达式 | **高** | 默认: `[ -=\w\[\]\{\}\(\)\@\|\.]+` |
| `channelname` | 频道名正则表达式 | **高** | 默认: `[ -=\w\#\[\]\{\}\(\)\@\|]+` |

### 9. 注册与发现

#### 已部分实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| registerName | `registerName` | `registerName` | 公开服务器名称 |

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `registerPassword` | 注册到公开列表的密码 | 低 | 公开服务器列表功能 |
| `registerHostname` | 注册主机名 | 低 | 公开服务器列表 |
| `registerLocation` | 服务器位置 | 低 | 地理位置信息 |
| `registerUrl` | 服务器网站 URL | 低 | 服务器官网 |
| `bonjour` | 启用 Bonjour/Zeroconf | 低 | 本地网络发现 |

### 10. 封禁系统

#### 未实现但重要 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `autobanAttempts` | 自动封禁尝试次数 | **高** | 默认10次 |
| `autobanTimeframe` | 自动封禁时间窗口（秒） | **高** | 默认120秒 |
| `autobanTime` | 自动封禁时长（秒） | **高** | 默认300秒 |
| `autobanSuccessfulConnections` | 成功连接后是否重置 | 中 | 默认true |

### 11. 日志与监控

#### 已部分实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| logFile | `logfile` | `logFile` | 日志文件路径 |

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `logdays` | 数据库日志保留天数 | 中 | 默认31天 |
| `obfuscate` | IP 地址混淆 | 低 | 隐私保护 | 不实现
| `sendversion` | 向客户端发送版本信息 | 低 | 默认true |
| `allowping` | 允许 ping | 低 | 默认true |

### 12. 数据库配置

#### 已实现 ✓

| 配置项 | Murmur | MuNode Hub | 说明 |
|-------|--------|------------|------|
| database | `database` | `database.path` | SQLite 数据库路径 |

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `sqlite_wal` | 启用 SQLite WAL 模式 | 中 | 性能优化，默认0 |
| `dbDriver` | 数据库驱动 | 低 | 支持 MySQL/PostgreSQL |
| `dbUsername` | 数据库用户名 | 低 | 外部数据库 |
| `dbPassword` | 数据库密码 | 低 | 外部数据库 |
| `dbHost` | 数据库主机 | 低 | 外部数据库 |
| `dbPort` | 数据库端口 | 低 | 外部数据库 |
| `dbPrefix` | 表前缀 | 低 | 外部数据库 |
| `dbOpts` | 数据库选项 | 低 | 外部数据库 |

### 13. ICE (RPC) 配置 ICE整体暂不实现

#### 不适用 N/A

Murmur 使用 ZeroC ICE 进行 RPC 通信，MuNode 使用自定义的 Protocol Buffers + smux 方案。

| Murmur 配置 | 说明 | MuNode 等价 |
|-----------|------|------------|
| `ice` | ICE 端点 | 使用 `port` (gRPC over smux) |
| `icesecret` | ICE 密钥 | 使用 TLS 客户端证书认证 |
| `icesecretread` | ICE 只读密钥 | N/A |
| `icesecretwrite` | ICE 写入密钥 | N/A |

### 14. Unix 特定配置

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `uname` | 运行用户 | 中 | Unix 系统安全 |
| `pidfile` | PID 文件路径 | 低 | 守护进程管理 |

### 15. Opus 编码配置

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `opusthreshold` | Opus 音频质量阈值 | 中 | 默认0，范围0-100 | 不实现


### 16. 高级功能

#### 未实现 ⚠️

| Murmur 配置 | 说明 | 优先级 | 建议 |
|-----------|------|--------|------|
| `broadcastlistenervolumeadjustments` | 广播监听者音量调整 | 低 | 默认false，Listen Channel 功能 |
| `allowRecording` | 允许录音 | 中 | 默认true，隐私相关 |
| `rollingStatsWindow` | 统计窗口时长（秒） | 低 | 默认300秒 |

## 实现优先级建议

### P0 - 关键（必须实现）

这些配置项对安全性、稳定性至关重要：

1. **用户与带宽限制**
   - `users` - 最大用户数
   - `bandwidth` - 每用户最大带宽
   - `textmessagelength` - 文本消息长度限制
   - `messagelimit` / `messageburst` - 消息速率限制

2. **安全认证**
   - `kdfiterations` - PBKDF2 迭代次数
   - `allowhtml` - HTML 消息控制（需实现过滤器）

3. **用户名验证**
   - `username` - 用户名正则验证
   - `channelname` - 频道名正则验证

4. **频道限制**
   - `channelnestinglimit` - 频道嵌套限制
   - `channelcountlimit` - 频道总数限制

5. **自动封禁**
   - `autobanAttempts` - 失败尝试次数
   - `autobanTimeframe` - 时间窗口
   - `autobanTime` - 封禁时长

6. **基础配置**
   - `timeout` - 客户端超时

### P1 - 重要（应该实现）

这些配置项增强用户体验和服务器管理：

1. **欢迎消息**
   - `welcometext` / `welcometextfile`

2. **频道行为**
   - `defaultchannel` - 默认频道
   - `rememberchannel` - 记住用户频道
   - `rememberchannelduration` - 记忆时长

3. **图片消息**
   - `imagemessagelength`

4. **服务器密码**
   - `serverpassword`

5. **日志管理**
   - `logdays` - 日志保留期

6. **数据库优化**
   - `sqlite_wal` - WAL 模式

7. **录音控制**
   - `allowRecording`

### P2 - 可选（未来考虑）

这些配置项用于高级功能或特殊场景：

1. **客户端建议**
   - `suggestversion`
   - `suggestpositional`
   - `suggestpushtotalk`

2. **服务器注册**
   - `registerPassword`
   - `registerHostname`
   - `registerLocation`
   - `registerUrl`

3. **插件消息限制**
   - `pluginmessagelimit`
   - `pluginmessageburst`

4. **高级安全**
   - `sslCiphers`
   - `forceExternalAuth`

5. **监听功能**
   - `listenersperchannel`
   - `listenersperuser`
   - `broadcastlistenervolumeadjustments`

6. **其他**
   - `opusthreshold`
   - `usersperchannel`
   - `obfuscate`
   - `sendversion`
   - `allowping`
   - `bonjour`

## 实现建议

### 1. 配置文件结构调整

建议更新 `HubConfig` 接口以包含新配置项：

```typescript
export interface HubConfig {
  // 现有配置...
  server_id: number;
  name: string;
  registerName?: string;
  host: string;
  port: number;
  
  // 新增：基础限制
  timeout?: number; // 默认: 30
  serverPassword?: string;
  maxUsers?: number; // 默认: 1000
  maxUsersPerChannel?: number; // 默认: 0 (无限制)
  maxBandwidth?: number; // 默认: 558000 (bps)
  
  // 新增：频道限制
  channelNestingLimit?: number; // 默认: 10
  channelCountLimit?: number; // 默认: 1000
  defaultChannel?: number; // 默认: 0 (Root)
  rememberChannel?: boolean; // 默认: true
  rememberChannelDuration?: number; // 默认: 0 (永久)
  
  // 新增：消息限制
  textMessageLength?: number; // 默认: 5000
  imageMessageLength?: number; // 默认: 131072
  messageLimit?: number; // 默认: 1
  messageBurst?: number; // 默认: 5
  pluginMessageLimit?: number; // 默认: 4
  pluginMessageBurst?: number; // 默认: 15
  allowHTML?: boolean; // 默认: true
  
  // 新增：认证与安全
  kdfIterations?: number; // 默认: -1 (自动)
  legacyPasswordHash?: boolean; // 默认: false
  certRequired?: boolean;
  forceExternalAuth?: boolean;
  
  // 新增：用户名验证
  usernameRegex?: string; // 默认: [ -=\w\[\]\{\}\(\)\@\|\.]+
  channelNameRegex?: string; // 默认: [ -=\w\#\[\]\{\}\(\)\@\|]+
  
  // 新增：欢迎消息
  welcomeText?: string;
  welcomeTextFile?: string;
  
  // 新增：自动封禁
  autoBan?: {
    attempts: number; // 默认: 10
    timeframe: number; // 默认: 120 (秒)
    duration: number; // 默认: 300 (秒)
    banSuccessfulConnections: boolean; // 默认: true
  };
  
  // 新增：客户端建议
  suggest?: {
    version?: string; // 格式: "1.4.0"
    positional?: boolean | null;
    pushToTalk?: boolean | null;
  };
  
  // 新增：高级功能
  allowRecording?: boolean; // 默认: true
  opusThreshold?: number; // 默认: 0
  broadcastListenerVolumeAdjustments?: boolean; // 默认: false
  
  // 新增：日志
  logDays?: number; // 默认: 31
  obfuscateIPs?: boolean; // 默认: false
  
  // 新增：数据库
  database: {
    path: string;
    backupDir: string;
    backupInterval: number;
    walMode?: boolean; // 默认: false
  };
  
  // 现有配置...
  tls: TLSConfig;
  registry: RegistryConfig;
  blobStore: BlobStoreConfig;
  webApi: WebApiConfig;
  logLevel: string;
  logFile?: string;
}
```

### 2. 实现路线图

#### 阶段 1: 核心安全与限制（P0）

1. 实现消息速率限制器（Token Bucket 算法）
2. 实现带宽限制
3. 实现用户名/频道名验证
4. 实现 PBKDF2 密码哈希（如尚未实现）
5. 实现频道嵌套/计数限制
6. 实现自动封禁系统

#### 阶段 2: 用户体验增强（P1）

1. 实现欢迎消息系统
2. 实现频道记忆功能
3. 实现图片消息大小限制
4. 实现服务器密码
5. 实现日志保留策略
6. 启用 SQLite WAL 模式

#### 阶段 3: 高级功能（P2）

1. 实现客户端版本/配置建议
2. 实现服务器注册到公开列表
3. 实现插件消息限制
4. 实现外部认证集成
5. 实现高级监听功能

### 3. HTML 过滤器实现

如果启用 `allowHTML`，必须实现 HTML 白名单过滤器。可参考：

- Murmur 的 HTMLFilter: `htmlfilter/htmlfilter.go`
- 使用库如 `sanitize-html` (Node.js)

建议白名单标签：
- 文本格式: `<b>`, `<i>`, `<u>`, `<s>`, `<span>`
- 结构: `<br>`, `<p>`, `<div>`
- 链接: `<a href="...">`（验证协议）
- 媒体: `<img src="...">`（限制来源）

禁止：
- 脚本: `<script>`, `<iframe>`, 事件属性 (`onclick` 等)
- 样式: 限制或禁止 `<style>` 和 `style` 属性

### 4. 速率限制实现

建议使用 Token Bucket 算法：

```typescript
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  
  constructor(
    private limit: number,    // 每秒限制
    private burst: number     // 突发容量
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }
  
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }
  
  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.limit;
    this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
```

### 5. 配置验证

实现配置验证器确保配置值合法：

```typescript
function validateHubConfig(config: HubConfig): void {
  if (config.maxUsers && config.maxUsers < 1) {
    throw new Error('maxUsers must be at least 1');
  }
  
  if (config.channelNestingLimit && config.channelNestingLimit < 1) {
    throw new Error('channelNestingLimit must be at least 1');
  }
  
  if (config.usernameRegex) {
    try {
      new RegExp(config.usernameRegex);
    } catch (e) {
      throw new Error('Invalid usernameRegex');
    }
  }
  
  // ... 更多验证
}
```

## 与 Edge Server 的关系

某些配置项需要 Hub 和 Edge 协调：

### Hub 负责配置和同步：

- 用户名/频道名验证规则
- 频道限制
- 欢迎消息
- 客户端建议配置
- 录音权限

### Edge 负责执行：

- 带宽限制
- 消息速率限制
- HTML 过滤
- 超时管理

### 同步机制：

Hub 应通过控制消息将这些配置同步到所有 Edge：

```typescript
interface ConfigSync {
  type: 'CONFIG_UPDATE';
  config: {
    maxBandwidth: number;
    textMessageLength: number;
    messageLimit: number;
    messageBurst: number;
    allowHTML: boolean;
    usernameRegex: string;
    channelNameRegex: string;
    // ...
  };
}
```

## 向后兼容性

新增配置项应提供合理的默认值，确保现有配置文件无需修改即可继续工作。

建议：
1. 所有新配置项都是可选的
2. 提供与 Murmur 一致的默认值
3. 配置加载时记录警告但不报错
4. 提供配置迁移工具

## 测试建议

1. **单元测试**
   - 速率限制器
   - HTML 过滤器
   - 用户名/频道名验证
   - 配置验证器

2. **集成测试**
   - 达到限制时的行为
   - 自动封禁触发
   - 配置同步（Hub -> Edge）

3. **压力测试**
   - 消息泛洪保护
   - 带宽限制有效性
   - 大量用户/频道场景

## 参考资料

- Murmur 配置文档: https://wiki.mumble.info/wiki/Murmur.ini
- Murmur 源码:
  - `src/murmur/Meta.cpp`: 配置读取
  - `src/murmur/Server.cpp`: 配置应用
  - `src/murmur/Meta.h`: 配置定义
- HTML 过滤: `htmlfilter/htmlfilter.go`
- 数据库配置: `src/murmur/database/ConfigTable.cpp`

## 总结

MuNode Hub Server 目前实现了基础的网络和注册表配置，但缺少许多 Murmur 的重要配置项，特别是：

1. **安全相关**: 速率限制、自动封禁、HTML 过滤、密码哈希
2. **限制相关**: 用户数、带宽、消息长度、频道限制
3. **用户体验**: 欢迎消息、频道记忆、客户端建议

建议按照优先级逐步实现这些配置项，优先完成 P0 级别的安全和限制相关配置，以确保服务器的稳定性和安全性。
