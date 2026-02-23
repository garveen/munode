# @munode/auth-service

TypeScript 用户认证服务包，配合 MuNode Rust Hub 使用。

## 工作原理

```
Mumble 客户端 ──TLS──▶ Edge ──RPC──▶ Hub ──WS──▶ @munode/auth-service
                                              ◀──────────────────────
```

1. Hub 在配置的 `network.auth_service_port` 端口上启动一个 WebSocket 服务端
2. 本包作为 WebSocket 客户端连接到 Hub
3. 当 Mumble 客户端登录时，Hub 通过 protobuf 二进制消息把认证请求发给本服务
4. 本服务调用用户提供的 `onAuth` 回调，并把结果回传给 Hub
5. Hub 根据结果允许或拒绝 Mumble 客户端连接

## Hub 配置 (`config/hub.js`)

```json
{
  "network": {
    "host": "0.0.0.0",
    "control_port": 8443,
    "auth_service_port": 8444
  },
  "auth": {
    "require_auth_service": true
  }
}
```

| 字段 | 说明 |
|------|------|
| `network.auth_service_port` | 认证服务 WS 端口（不设则禁用外部认证） |
| `auth.require_auth_service` | `true`：无认证服务时拒绝所有登录；`false`（默认）：回退到本地 DB 认证 |

## 用法

### 最小示例

```typescript
import { createAuthService } from '@munode/auth-service';

const service = createAuthService({
  hubUrl: 'ws://127.0.0.1:8444',
  onAuth: async (req) => {
    // req 包含: username, password, tokens, ip_address, certificate_hash 等
    const ok = req.username === 'alice' && req.password === 'secret';
    return {
      request_id: req.request_id,  // 必须原样回传
      success: ok,
      user_id: ok ? 1 : undefined,
      reason: ok ? undefined : 'Wrong password',
      reject_type: ok ? undefined : 3,  // 3 = WrongUserPW
    };
  },
});

service.start();
```

### 配置选项

```typescript
createAuthService({
  hubUrl: 'ws://127.0.0.1:8444',   // Hub WS 地址 (必填)
  onAuth: async (req) => { ... },   // 认证回调 (必填)
  serviceName: 'my-auth-service',   // 服务名称，用于日志 (可选)
  serviceVersion: '1.0.0',          // 版本号 (可选)
  reconnectIntervalMs: 5000,        // 断线重连间隔 ms (可选, 默认 5000)
  logLevel: 'info',                 // 日志级别 (可选, 默认 "info")
});
```

### `onAuth` 回调参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | `string` | 请求 ID（必须原样回传到响应） |
| `username` | `string` | 用户名 |
| `password` | `string` | 密码 |
| `tokens` | `string[]` | 访问令牌列表 |
| `session_id` | `number` | 客户端会话 ID |
| `server_id` | `number` | Edge 服务器 ID |
| `ip_address` | `string` | 客户端 IP |
| `ip_version` | `string` | `"IPv4"` 或 `"IPv6"` |
| `release` | `string` | Mumble 客户端版本字符串 |
| `os` / `os_version` | `string` | 客户端操作系统 |
| `certificate_hash` | `string?` | TLS 客户端证书哈希（可选） |

### `onAuth` 回调返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | `string` | 对应请求的 ID（必填） |
| `success` | `boolean` | 是否允许登录 |
| `user_id` | `number?` | 用户 ID（0 = 访客） |
| `username` | `string?` | 规范化用户名 |
| `display_name` | `string?` | 显示名称 |
| `groups` | `string[]?` | 用户所属组 |
| `reason` | `string?` | 拒绝理由（失败时） |
| `reject_type` | `number?` | 拒绝类型码（见下） |
| `channel_id` | `number?` | 覆盖初始频道 |
| `cert_required` | `boolean?` | 要求客户端证书 |

**拒绝类型码 (`reject_type`)**：

| 值 | 含义 |
|----|------|
| 1 | InvalidUsername |
| 2 | InvalidUserPW |
| 3 | WrongUserPW |
| 4 | WrongServerPW |
| 5 | UsernameInUse |
| 6 | ServerFull |
| 7 | NoCertificate |
| 8 | AuthenticatorFail |
