# 02 - OCB2-AES128 语音加密

## 状态: ❌ 未实现

当前 CryptSetup 发送随机密钥但不执行实际加密/解密。UDP 语音包以明文传输。

## 当前实现

- CryptSetup 消息发送 key(16字节)、client_nonce(16字节)、server_nonce(16字节)
- 客户端发送 CryptSetup 时更新 nonce，服务端回复确认
- UDP 服务器直接转发原始数据，无加密处理

## 目标功能

### OCB2-AES128 算法

Mumble 使用 OCB2 (Offset CodeBook mode 2) + AES-128 进行语音加密:

- **密钥**: 16 字节 AES-128 密钥 (登录时通过 CryptSetup 分发)
- **Nonce/IV**: 16 字节，前 4 字节为包序号 (little-endian u32)，后 12 字节随机
- **认证标签**: 3 字节 (截断的 OCB2 tag)
- **格式**: `[header:1byte][nonce_lsb:3bytes][encrypted_payload][tag:3bytes]`

### 加密流程

```
发送 (服务端→客户端):
1. 递增 server_nonce (LE u32 在前4字节)
2. OCB2-AES128 加密 voice_data，得到 ciphertext + tag
3. 发送: header(1) + nonce_lsb(3) + ciphertext + tag(3)

接收 (客户端→服务端):
1. 从 nonce_lsb(3字节) 恢复完整 nonce
2. OCB2-AES128 解密验证
3. 如果失败，尝试 late nonce (允许±几个包的乱序)
4. 更新统计: good/late/lost/resync
```

### Rust 实现

```rust
// 新文件: munode-edge/src/crypto.rs

use aes::Aes128;

struct CryptState {
    key: [u8; 16],
    encrypt_iv: [u8; 16],
    decrypt_iv: [u8; 16],
    encrypt_history: [u8; 256],
    decrypt_history: [u8; 256],
    good: u32,
    late: u32,
    lost: u32,
    resync: u32,
}

impl CryptState {
    fn new() -> Self;
    fn generate_key(&mut self);
    fn set_key(&mut self, key: &[u8; 16], encrypt_iv: &[u8; 16], decrypt_iv: &[u8; 16]);
    
    /// 加密语音包 (服务端→客户端)
    fn encrypt(&mut self, source: &[u8], dst: &mut Vec<u8>);
    
    /// 解密语音包 (客户端→服务端)
    fn decrypt(&mut self, source: &[u8], dst: &mut Vec<u8>) -> bool;
    
    /// OCB2 核心: 分块加密 + 认证
    fn ocb_encrypt(key: &Aes128, nonce: &[u8; 16], plain: &[u8], cipher: &mut [u8], tag: &mut [u8; 3]);
    fn ocb_decrypt(key: &Aes128, nonce: &[u8; 16], cipher: &[u8], plain: &mut [u8], tag: &[u8; 3]) -> bool;
}
```

### 集成点

1. **登录时**: 生成密钥，通过 CryptSetup 发送给客户端
2. **UDP 接收**: 解密后解析语音头 (type + target + session + sequence)
3. **UDP 发送**: 加密后发送给目标客户端
4. **TCP UDPTunnel**: 同样需要加密/解密
5. **Ping 统计**: 在 Ping 响应中返回 good/late/lost/resync
6. **Nonce 同步**: 处理客户端 CryptSetup 请求更新 nonce

### 依赖

```toml
aes = "0.8"       # AES-128 block cipher
```

注: OCB2 模式需要自行实现，因为 Rust 的 `aes-gcm` / `aes-ocb` 等库实现的是 OCB3，
而 Mumble 使用的是 OCB2 (RFC 7253 之前的版本)。
参考 Mumble 官方 C++ 实现: `src/crypto/CryptStateOCB2.cpp`

### 影响范围

- 新建 `munode-edge/src/crypto.rs`
- `munode-edge/src/server.rs` - CryptSetup 处理加密状态
- `munode-edge/src/udp.rs` - UDP 包加密/解密
- `munode-edge/src/client.rs` - 每个客户端持有 CryptState
- `munode-edge/src/handler.rs` - Ping 返回加密统计
