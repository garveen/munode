# MuNode Web Client 开发参考文档

> **目标读者**：需要用浏览器连接 MuNode Edge 的 Web 客户端开发者。  
> **版本**：与 MuNode Edge `webtransport` / `ws-transport` feature flag 对应。  
> **协议基础**：[Mumble 协议](../packages/protocol/proto/Mumble.proto)，MuNode 在其之上叠加了 WebTransport 和 WebSocket 两条传输路径。

---

## 目录

1. [传输层选择](#1-传输层选择)
2. [WebTransport 路径（推荐）](#2-webtransport-路径推荐)
3. [WebSocket 路径（兜底）](#3-websocket-路径兜底)
4. [Mumble 帧格式](#4-mumble-帧格式)
5. [登录握手流程](#5-登录握手流程)
6. [消息类型速查表](#6-消息类型速查表)
7. [语音传输](#7-语音传输)
8. [Protobuf 编解码](#8-protobuf-编解码)
9. [TypeScript 示例代码](#9-typescript-示例代码)
10. [重连策略](#10-重连策略)
11. [浏览器兼容性](#11-浏览器兼容性)
12. [服务端配置参考](#12-服务端配置参考)

---

## 1. 传输层选择

| 特性 | WebTransport (QUIC/HTTP3) | WebSocket (TCP) |
|------|--------------------------|-----------------|
| 协议 | HTTP/3 over QUIC | HTTP/1.1 Upgrade |
| 默认端口 | `64740` | `8443` |
| 加密 | 内置 TLS 1.3（QUIC 强制要求） | 需要反向代理 (`wss://`) 或裸 `ws://` |
| CryptSetup | **跳过**（传输层已加密） | **跳过**（同上） |
| 浏览器要求 | Chrome 97 +、Edge 97 + | 全浏览器 |
| 推荐场景 | 生产环境、低延迟语音 | 兜底 / Safari / 旧浏览器 |

**推荐策略**：先尝试 WebTransport，失败则降级到 WebSocket。

```typescript
async function connectBestTransport(edgeHost: string) {
  if (typeof WebTransport !== 'undefined') {
    try {
      return await connectWebTransport(edgeHost);
    } catch {
      console.warn('WebTransport unavailable, falling back to WebSocket');
    }
  }
  return connectWebSocket(edgeHost);
}
```

---

## 2. WebTransport 路径（推荐）

### 2.1 连接 URL

```
https://<external_host>:<wt_port>
```

默认配置下为 `https://<edge-host>:64740`。Edge 不提供额外的路径或 subprotocol，浏览器直接连接到根 HTTPS URL。

### 2.2 证书要求

QUIC 要求有效的 TLS 证书，浏览器对此有两种接受方式：

**方式 A — 公信 CA（生产推荐）**  
使用 Let's Encrypt 或其他公信 CA 颁发的证书，浏览器直接信任，无需额外配置。

**方式 B — 自签证书（开发 / 测试）**  
将服务端证书的 SHA-256 指纹通过 `serverCertificateHashes` 传给浏览器：

```typescript
const transport = new WebTransport(url, {
  serverCertificateHashes: [
    {
      algorithm: 'sha-256',
      value: hexToArrayBuffer('AA:BB:CC:...')  // 证书 SHA-256 指纹（去掉冒号后 hex decode）
    }
  ]
});
```

> **注意**：使用 `serverCertificateHashes` 时，证书有效期不得超过 14 天（浏览器限制）。

### 2.3 建立连接

```typescript
const url = 'https://edge.example.com:64740';
const transport = new WebTransport(url);

// 等待 QUIC 握手完成
await transport.ready;

// 立即打开控制流（一个会话只需一条双向流）
const stream = await transport.createBidirectionalStream();
const writer = stream.writable.getWriter();
const reader = stream.readable.getReader();
```

### 2.4 控制流协议

每条控制流 = 一个 Mumble 客户端会话。所有 Mumble 帧（包括语音 `UdpTunnel` 帧）都在这条流上顺序发送。

帧格式见 [§4 Mumble 帧格式](#4-mumble-帧格式)。

### 2.5 会话生命周期

```
浏览器                          Edge
  │── WebTransport QUIC Handshake ──→│
  │←── transport.ready ─────────────│
  │── createBidirectionalStream() ──→│
  │                                  │
  │── [Version frame] ──────────────→│
  │── [Authenticate frame] ─────────→│
  │←── [CryptSetup] ─────────────────│  ⚠️ 不会收到！WT 路径跳过
  │←── [Version frame] ──────────────│
  │←── [CodecVersion] ───────────────│
  │←── [ChannelState] ×N ────────────│
  │←── [UserState] ×N ───────────────│
  │←── [ServerSync] ─────────────────│  ← 登录完成
  │←── [ServerConfig] ───────────────│
  │                                  │
  │  (双向 Mumble 帧交换) ...         │
  │── transport.close() ────────────→│
```

---

## 3. WebSocket 路径（兜底）

### 3.1 连接 URL

```
ws://<host>:<ws_fallback_port>
```

默认为 `ws://<edge-host>:8443`（裸 TCP）。若在反向代理后启用了 TLS 终止，则使用 `wss://`。

**路径**：任意路径均可（Edge 不检查路径），通常用 `/mumble` 或 `/`。

### 3.2 建立连接

```typescript
const ws = new WebSocket('ws://edge.example.com:8443', ['binary']);
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  // 连接就绪，开始发送 Version 帧
  sendFrame(ws, MessageType.Version, encodeVersion());
};
```

### 3.3 消息格式

每条 WebSocket **binary message** = 一个完整的 Mumble 帧：

```
[type : u16 BE][length : u32 BE][protobuf payload bytes]
```

不可把多个 Mumble 帧合并到一条 WS 消息中，也不可拆分一个帧到多条消息。

### 3.4 安全注意

裸 `ws://` 不加密，仅适合本地开发或内网。生产部署应使用反向代理（nginx / Caddy）将 `wss://` 终止到 Edge 的 `ws://`：

```nginx
# nginx 示例
location /mumble {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

---

## 4. Mumble 帧格式

### 4.1 帧结构

```
┌──────────┬──────────────┬──────────────────────────┐
│ type     │ length       │ payload                  │
│ u16 BE   │ u32 BE       │ (length bytes)           │
│ 2 bytes  │ 4 bytes      │ Protobuf 编码的消息体     │
└──────────┴──────────────┴──────────────────────────┘
```

- `type`：消息类型枚举值（见 [§6](#6-消息类型速查表)）
- `length`：payload 字节数（不含 header 的 6 字节）
- `payload`：Protobuf 编码后的消息体

### 4.2 JavaScript 编解码

```typescript
/** 编码一条 Mumble 帧 */
function encodeFrame(type: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(6 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint16(0, type, false);           // type, big-endian
  view.setUint32(2, payload.byteLength, false); // length, big-endian
  new Uint8Array(buf, 6).set(payload);
  return buf;
}

/** 从字节流中解析帧（适用于 WebTransport ReadableStream） */
class FrameDecoder {
  private buf = new Uint8Array(0);

  /** 追加新收到的字节 */
  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  /** 尝试读取一个完整帧；不够时返回 null */
  next(): { type: number; payload: Uint8Array } | null {
    if (this.buf.length < 6) return null;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset);
    const type = view.getUint16(0, false);
    const length = view.getUint32(2, false);
    if (this.buf.length < 6 + length) return null;
    const payload = this.buf.slice(6, 6 + length);
    this.buf = this.buf.slice(6 + length);
    return { type, payload };
  }
}
```

---

## 5. 登录握手流程

### 5.1 CryptSetup 差异

> **重要**：WebTransport 和 WebSocket 路径**不发送** `CryptSetup`（消息类型 15）。  
> 传统 Mumble 客户端通过 TCP/TLS 连接时，服务端会在 Authenticate 之前发送 CryptSetup 来协商 OCB2-AES128 UDP 加密密钥。Web 路径已通过传输层（QUIC TLS 或 WSS）加密，OCB2 不再需要，故该消息被跳过。

### 5.2 完整登录序列

**客户端发送（顺序）**：

1. **Version**（type=1）
2. **Authenticate**（type=2）

**服务端回复（顺序）**：

1. **Version**（type=1）— 服务端版本信息
2. **CodecVersion**（type=21）— 服务端支持的语音编解码器
3. **ChannelState**（type=7）×N — 所有频道
4. **UserState**（type=9）×N — 所有已在线用户（含自身）
5. **ServerSync**（type=8）— 登录完成，携带 `session`（本次会话 ID）
6. **ServerConfig**（type=24）— 服务端配置（最大消息长度、图片大小限制等）

收到 `ServerSync` 即代表登录成功，`ServerSync.session` 是本会话的 session ID。

### 5.3 Version 消息

```typescript
import { MumbleProto } from './proto/Mumble_pb'; // 由 ts-proto 生成

const versionMsg = MumbleProto.Version.create({
  versionV1: 0x00010400,          // Mumble 1.4.0
  release: 'web-client',
  os: 'Web',
  osVersion: navigator.userAgent,
});

sendFrame(MessageType.Version, MumbleProto.Version.encode(versionMsg).finish());
```

`versionV1` 编码格式：`(major << 16) | (minor << 8) | patch`，`0x00010400` = 1.4.0。

### 5.4 Authenticate 消息

```typescript
const authMsg = MumbleProto.Authenticate.create({
  username: 'Alice',
  password: 'secret',       // 可选，有密码保护时填写
  tokens: [],               // 频道访问 token（optional）
  celtVersions: [],         // 旧版 CELT，可留空
  opus: true,               // 声明支持 Opus
});

sendFrame(MessageType.Authenticate, MumbleProto.Authenticate.encode(authMsg).finish());
```

### 5.5 登录失败

若认证失败，服务端发送 **Reject**（type=5）消息：

```typescript
// 字段：type (RejectType enum), reason (string)
// 常见 type 值：
//   WrongVersion = 1
//   InvalidUsername = 2
//   WrongUserPW = 3
//   WrongServerPW = 4
//   UsernameInUse = 5
//   ServerFull = 6
//   NoCertificate = 7
```

---

## 6. 消息类型速查表

下表仅列出 Web 客户端常用消息类型。完整枚举见 `packages/protocol/proto/Mumble.proto`。

| 类型名称 | 类型编号 | 方向 | 说明 |
|---------|---------|------|------|
| `UdpTunnel` | 1 | 双向 | 语音包隧道（Web 客户端唯一的语音通道） |
| `Version` | 1 | 双向 | 版本协商 |
| `Authenticate` | 2 | C→S | 登录认证 |
| `Ping` | 3 | 双向 | 心跳保活 |
| `Reject` | 5 | S→C | 登录拒绝 |
| `ServerSync` | 8 | S→C | 登录完成 + session ID |
| `ChannelRemove` | 9 | S→C | 频道删除 |
| `ChannelState` | 7 | 双向 | 频道状态（创建/更新/初始同步） |
| `UserRemove` | 10 | S→C | 用户离线 |
| `UserState` | 9 | 双向 | 用户状态（加入/移动/静音等） |
| `TextMessage` | 11 | 双向 | 文字聊天 |
| `PermissionDenied` | 13 | S→C | 权限不足 |
| `CryptSetup` | 15 | S→C | OCB2 密钥协商（**Web 路径不发送**） |
| `CodecVersion` | 21 | S→C | 服务端支持的编解码器 |
| `ServerConfig` | 24 | S→C | 服务端配置（消息大小限制等） |
| `SuggestConfig` | 25 | S→C | 服务端建议客户端配置 |
| `RequestBlob` | 14 | C→S | 请求用户头像 / 注释 |
| `UserList` | 28 | 双向 | 注册用户列表（管理员） |
| `ACL` | 29 | 双向 | 频道权限（管理员） |
| `QueryUsers` | 26 | 双向 | 查询注册用户 |

> **注意**：`UdpTunnel` 和 `Version` 共享编号 1；区分方式为上下文——发送方向为 C→S 的 type=1 是语音，S→C 的 type=1 带版本字段是 Version。实际上在实现中通过帧大小 + payload 首字节区分：语音帧 payload 首字节的高 5 bit 为 `0b10101` (Opus) 时是 UdpTunnel，否则为 Version。

---

## 7. 语音传输

Web 客户端**不使用 UDP**，所有语音包通过控制流上的 `UdpTunnel`（type=1）帧传输。

### 7.1 语音帧格式（Opus）

```
UdpTunnel payload（控制流上发送）:
┌───────────────────────────────────────────────────┐
│ header (1 byte)                                   │
│   bits 7-5 : packet type = 0b100 (Opus TCP tunnel)│
│   bits 4-0 : voice target = 0 (default channel)  │
├───────────────────────────────────────────────────┤
│ sequence (varint, 1-2 bytes)                      │
├───────────────────────────────────────────────────┤
│ opus data length (varint, 1-2 bytes)              │
│   bit 13 set = 最后一帧（PTT 释放）               │
├───────────────────────────────────────────────────┤
│ opus audio bytes (compressed audio)               │
└───────────────────────────────────────────────────┘
```

**header 字节**：  
- `0x80` = Opus，默认频道（target=0）  
- `0x81`～`0x8F` = Opus，voice target 1-15

**varint 编码**：Mumble 使用小 varint——若 MSB 为 0，则为单字节值；若 MSB 为 1，则低 7 bit 合并下一字节的 8 bit（共 15 bit）。

```typescript
function encodeVarint(value: number): Uint8Array {
  if (value < 0x80) {
    return new Uint8Array([value]);
  }
  return new Uint8Array([
    0x80 | (value >> 8),
    value & 0xff
  ]);
}
```

### 7.2 发送语音帧示例

```typescript
let voiceSequence = 0;

function sendVoiceFrame(opusData: Uint8Array, lastFrame = false): void {
  const header = 0x80;  // Opus, target=0
  const seqBytes = encodeVarint(voiceSequence++);
  let lenValue = opusData.byteLength;
  if (lastFrame) lenValue |= 0x2000;  // bit 13: end of transmission
  const lenBytes = encodeVarint(lenValue);

  const total = 1 + seqBytes.length + lenBytes.length + opusData.byteLength;
  const payload = new Uint8Array(total);
  let offset = 0;
  payload[offset++] = header;
  payload.set(seqBytes, offset); offset += seqBytes.length;
  payload.set(lenBytes, offset); offset += lenBytes.length;
  payload.set(opusData, offset);

  sendFrame(MessageType.UdpTunnel, payload);
}
```

### 7.3 接收语音帧

收到 `UdpTunnel`（type=1）帧时，payload 结构相同，解析后用 Opus 解码器（如 `opusscript` 或 WebAssembly Opus）播放。

### 7.4 心跳保活

每 15 秒发送一次 `Ping` 以维持连接：

```typescript
const pingMsg = MumbleProto.Ping.create({
  timestamp: BigInt(Date.now()),
});
sendFrame(MessageType.Ping, MumbleProto.Ping.encode(pingMsg).finish());
```

---

## 8. Protobuf 编解码

### 8.1 推荐工具

| 工具 | 特点 |
|------|------|
| [`ts-proto`](https://github.com/stephenh/ts-proto) | 生成 TypeScript 原生类，推荐 |
| [`protobufjs`](https://protobufjs.github.io/protobuf.js/) | 运行时动态加载 `.proto`，灵活 |

### 8.2 使用 ts-proto 生成类型

```bash
# 安装
pnpm add ts-proto

# 生成（以 Mumble.proto 为例）
npx protoc \
  --plugin=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=./src/proto \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=env=browser \
  packages/protocol/proto/Mumble.proto
```

生成后导入使用：

```typescript
import { Version, Authenticate, ServerSync, ChannelState, UserState } from './proto/Mumble';
```

### 8.3 使用 protobufjs 动态加载

```typescript
import protobuf from 'protobufjs';

const root = await protobuf.load('/proto/Mumble.proto');
const Version = root.lookupType('MumbleProto.Version');

// 编码
const payload = Version.encode(Version.create({
  versionV1: 0x00010400,
  os: 'Web',
  release: 'web-client',
})).finish();

// 解码
const msg = Version.decode(new Uint8Array(payload));
```

---

## 9. TypeScript 示例代码

以下是一个完整的最小化连接示例，演示 WebTransport 路径的登录流程。

```typescript
import { Version, Authenticate, ServerSync, ChannelState, UserState, Ping } from './proto/Mumble';

// 消息类型枚举（与 Mumble.proto MessageType 对应）
const enum MessageType {
  UdpTunnel    = 1,
  Version      = 1,   // 同值，按上下文区分
  Authenticate = 2,
  Ping         = 3,
  Reject       = 5,
  ChannelState = 7,
  ServerSync   = 8,
  ChannelRemove = 9,
  UserRemove   = 10,
  UserState    = 9,   // 同值
  TextMessage  = 11,
  PermissionDenied = 13,
  CryptSetup   = 15,
  CodecVersion = 21,
  ServerConfig = 24,
}

// ---- 帧编解码 ----

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(6 + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint16(0, type, false);
  view.setUint32(2, payload.byteLength, false);
  buf.set(payload, 6);
  return buf;
}

interface MumbleFrame {
  type: number;
  payload: Uint8Array;
}

// ---- WebTransport 客户端 ----

export class MuNodeWebTransportClient {
  private transport!: WebTransport;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new FrameDecoderStream();

  public sessionId = 0;
  public onChannelState?: (ch: ChannelState) => void;
  public onUserState?: (u: UserState) => void;
  public onTextMessage?: (from: number, text: string) => void;
  public onVoice?: (sessionId: number, opusData: Uint8Array) => void;

  async connect(url: string, username: string, password = ''): Promise<void> {
    this.transport = new WebTransport(url);
    await this.transport.ready;

    const stream = await this.transport.createBidirectionalStream();
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();

    // 启动接收循环
    this.startReceiveLoop();

    // 开始心跳
    setInterval(() => this.sendPing(), 15_000);

    // 发送 Version
    await this.sendFrame(1, Version.encode(Version.create({
      versionV1: 0x00010400,
      release: 'web-client',
      os: 'Web',
      osVersion: navigator.userAgent,
    })).finish());

    // 发送 Authenticate
    await this.sendFrame(2, Authenticate.encode(Authenticate.create({
      username,
      password,
      opus: true,
    })).finish());
  }

  private async sendFrame(type: number, payload: Uint8Array): Promise<void> {
    await this.writer.write(encodeFrame(type, payload));
  }

  private async sendPing(): Promise<void> {
    await this.sendFrame(3, Ping.encode(Ping.create({
      timestamp: BigInt(Date.now()),
    })).finish());
  }

  private async startReceiveLoop(): Promise<void> {
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.decoder.push(value);
      let frame: MumbleFrame | null;
      while ((frame = this.decoder.next()) !== null) {
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: MumbleFrame): void {
    const { type, payload } = frame;
    switch (type) {
      case 1: {
        // UdpTunnel (voice) vs Version — distinguish by payload content
        // Version payload is valid protobuf; voice payload starts with audio header byte
        const firstByte = payload[0];
        if ((firstByte & 0xe0) === 0x80) {
          // Opus voice frame
          this.handleVoiceFrame(payload);
        }
        // else: Version response from server (ignore after login)
        break;
      }
      case 5: {
        const reject = Reject.decode(payload);
        console.error('Login rejected:', reject.reason);
        this.transport.close();
        break;
      }
      case 7: {
        const ch = ChannelState.decode(payload);
        this.onChannelState?.(ch);
        break;
      }
      case 8: {
        const sync = ServerSync.decode(payload);
        this.sessionId = sync.session;
        console.info('Logged in, session:', this.sessionId);
        break;
      }
      case 9: {
        // UserState (shared enum value with ChannelRemove=9 — distinguish by size/fields)
        const user = UserState.decode(payload);
        this.onUserState?.(user);
        break;
      }
      case 11: {
        const txt = TextMessage.decode(payload);
        this.onTextMessage?.(txt.actor ?? 0, txt.message);
        break;
      }
      default:
        break;
    }
  }

  private handleVoiceFrame(payload: Uint8Array): void {
    // payload[0] = header, parse session from voice packet
    // For received voice, the source session is prepended by the server
    // Full parsing left to application; expose raw payload here
    // this.onVoice?.(session, opusBytes);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }
}

// ---- 帧解码器（流式缓冲） ----

class FrameDecoderStream {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  next(): MumbleFrame | null {
    if (this.buf.length < 6) return null;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const type = view.getUint16(0, false);
    const length = view.getUint32(2, false);
    if (this.buf.length < 6 + length) return null;
    const payload = this.buf.slice(6, 6 + length);
    this.buf = this.buf.slice(6 + length);
    return { type, payload };
  }
}
```

### 9.1 WebSocket 版本（结构相同）

WebSocket 版本的差异仅在传输层：

```typescript
export class MuNodeWebSocketClient {
  private ws!: WebSocket;
  private decoder = new FrameDecoderStream();

  // 注意：WebSocket 每条消息已是完整帧，无需流式缓冲；
  // 但保持统一接口，push + next 同样适用。

  async connect(url: string, username: string, password = ''): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = async () => {
        await this.sendLogin(username, password);
        resolve();
      };

      this.ws.onmessage = (evt) => {
        const data = new Uint8Array(evt.data as ArrayBuffer);
        this.decoder.push(data);
        let frame: MumbleFrame | null;
        while ((frame = this.decoder.next()) !== null) {
          this.handleFrame(frame);
        }
      };

      this.ws.onerror = (e) => reject(e);
    });
  }

  private async sendLogin(username: string, password: string): Promise<void> {
    this.sendFrame(1, Version.encode(Version.create({
      versionV1: 0x00010400, os: 'Web', release: 'web-client',
    })).finish());
    this.sendFrame(2, Authenticate.encode(Authenticate.create({
      username, password, opus: true,
    })).finish());
  }

  private sendFrame(type: number, payload: Uint8Array): void {
    this.ws.send(encodeFrame(type, payload));
  }

  // handleFrame — 同 WebTransport 版本
  private handleFrame(_frame: MumbleFrame): void { /* ... */ }
}
```

---

## 10. 重连策略

### 10.1 Phase 1 行为

当前版本（Phase 1）**无会话续期**。连接断开后需要完整重新认证。

```typescript
async function connectWithRetry(url: string, username: string, password: string) {
  let delay = 1000;
  while (true) {
    try {
      const client = new MuNodeWebTransportClient();
      await client.connect(url, username, password);
      return client;
    } catch (err) {
      console.warn(`连接失败，${delay}ms 后重试`, err);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);  // 指数退避，最长 30 秒
    }
  }
}
```

### 10.2 连接断开检测

- **WebTransport**：监听 `transport.closed` Promise
- **WebSocket**：监听 `ws.onclose` 事件

---

## 11. 浏览器兼容性

| 浏览器 | WebTransport | WebSocket |
|--------|-------------|-----------|
| Chrome 97 + | ✅ | ✅ |
| Edge 97 + | ✅ | ✅ |
| Firefox 114 + | ⚠️ 部分支持 | ✅ |
| Safari 17 + | ❌ 不支持 | ✅ |
| Mobile Chrome | ✅ | ✅ |
| Mobile Safari | ❌ | ✅ |

> **推荐实现**：以 WebTransport 为主路径，`typeof WebTransport === 'undefined'` 时自动降级到 WebSocket。

---

## 12. 服务端配置参考

Edge 配置文件（`config/edge.toml`）中的 `[webtransport]` 节：

```toml
[webtransport]
# 是否启用 WebTransport 监听
enabled = true

# 绑定地址（内网）
host = "0.0.0.0"
port = 64740

# 对外公告地址（浏览器连接用）
external_host = "edge.example.com"
external_port = 64740

# 证书（不填则复用主 TLS 证书）
cert = "/etc/certs/edge.pem"
key  = "/etc/certs/edge.key"

# 是否在服务发现中通告此端点
advertise = true

# 每连接最大双向流数
max_streams = 4

# 证书重载间隔秒数（Phase 2 功能，当前仅记录日志）
cert_reload_interval_secs = 86400

# WebSocket 兜底监听
ws_fallback_enabled = true
ws_fallback_host    = "0.0.0.0"
ws_fallback_port    = 8443
```

### 12.1 端口规划

| 端口 | 协议 | 用途 |
|------|------|------|
| 64738 | TCP/TLS | 标准 Mumble 原生客户端 |
| 64738 | UDP | OCB2-AES128 语音（原生客户端） |
| 64739 | WS/TCP | Edge ↔ Hub 内部控制通道 |
| **64740** | **QUIC (HTTP/3)** | **WebTransport（浏览器）** |
| **8443** | **WS/TCP** | **WebSocket 兜底（浏览器）** |

---

## 附录 A：Mumble.proto 关键消息字段速查

### Version

```protobuf
message Version {
  optional uint32 version_v1 = 1;   // 编码：(major<<16)|(minor<<8)|patch
  optional string release    = 2;   // 客户端名称字符串
  optional string os         = 3;   // 操作系统名称
  optional string os_version = 4;   // OS 版本或 UserAgent
  optional uint64 version_v2 = 5;   // 新版本编码（可选）
}
```

### Authenticate

```protobuf
message Authenticate {
  optional string username = 2;
  optional string password = 3;
  repeated string tokens   = 4;  // 频道密码 token
  repeated int32  celt_versions = 5;  // 留空
  optional bool   opus     = 7;  // 必须为 true
}
```

### ServerSync

```protobuf
message ServerSync {
  optional uint32 session         = 1;  // ← 本次会话 ID
  optional uint32 max_bandwidth   = 2;
  optional string welcome_text    = 3;
  optional uint64 permissions     = 4;
}
```

### UserState

```protobuf
message UserState {
  optional uint32 session        = 1;   // 会话 ID
  optional uint32 actor          = 2;   // 触发者 session（服务端填写）
  optional string name           = 3;
  optional uint32 user_id        = 4;   // 注册用户 ID（0=未注册）
  optional uint32 channel_id     = 5;   // 所在频道
  optional bool   mute           = 6;
  optional bool   deaf           = 7;
  optional bool   suppress       = 8;   // 被管理员静音
  optional bool   self_mute      = 9;
  optional bool   self_deaf      = 10;
  optional bytes  texture        = 11;  // 头像（大型，用 RequestBlob 懒加载）
  optional bytes  plugin_context = 12;
  optional string plugin_identity = 13;
  optional string comment        = 14;
  optional string hash           = 15;  // 客户端证书指纹
}
```

### ChannelState

```protobuf
message ChannelState {
  optional uint32 channel_id    = 1;
  optional uint32 parent        = 2;   // 父频道 ID
  optional string name          = 3;
  repeated uint32 links         = 4;   // 链接频道
  optional string description   = 5;
  repeated uint32 links_add     = 6;
  repeated uint32 links_remove  = 7;
  optional bool   temporary     = 8;
  optional int32  position      = 9;
  optional bytes  description_hash = 11;
  optional uint32 max_users     = 12;
  optional bool   is_enter_restricted = 13;
  optional bool   can_enter     = 14;
}
```

---

*文档最后更新：与 MuNode `rust/munode-edge` WebTransport/WebSocket 实现同步。*
