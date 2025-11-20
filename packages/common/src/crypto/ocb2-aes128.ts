import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * OCB2-AES128 加密模式实现
 * 基于 mumble-streams 的实现，与 Mumble 协议兼容
 *
 * 原始实现来源: https://github.com/Johni0702/mumble-streams/blob/master/lib/udp-crypto.js
 * 版权声明: Copyright 2005-2016 The Mumble Developers. All rights reserved.
 */

/**
 * 加密统计信息
 */
export interface CryptStats {
  good: number;
  late: number;
  lost: number;
  resync: number;
}

export class OCB2AES128 {
  private key?: Buffer;
  private encryptIV?: Buffer;
  private decryptIV?: Buffer;
  private decryptHistory: number[] = new Array(256);

  // 本地统计（本地解密时的统计 - 对方发送->本机接收）
  // 对应 Go 的 Good/Late/Lost/Resync 和 Mumble 客户端的 m_statsLocal
  public localStats: CryptStats = { good: 0, late: 0, lost: 0, resync: 0 };
  
  // 远端统计（远端的接收统计，从对方的Ping消息中读取）
  // 对应 Go 的 RemoteGood/RemoteLate/RemoteLost/RemoteResync 和 Mumble 客户端的 m_statsRemote
  public remoteStats: CryptStats = { good: 0, late: 0, lost: 0, resync: 0 };

  private static readonly BLOCK_SIZE = 16;
  private lastGoodTime: number = Date.now();

  constructor() {
    // 初始化解密历史记录
    this.decryptHistory.fill(0);
  }

  /**
   * 检查加密器是否就绪
   */
  ready(): boolean {
    return !!(this.key && this.encryptIV && this.decryptIV);
  }

  /**
   * 生成新的加密密钥
   */
  generateKey(): void {
    const buf = randomBytes(OCB2AES128.BLOCK_SIZE * 3);
    this.key = buf.slice(0, OCB2AES128.BLOCK_SIZE);
    this.decryptIV = buf.slice(OCB2AES128.BLOCK_SIZE, OCB2AES128.BLOCK_SIZE * 2);
    this.encryptIV = buf.slice(OCB2AES128.BLOCK_SIZE * 2);
  }

  /**
   * 设置密钥和IV
   */
  setKey(key: Buffer, encryptIV: Buffer, decryptIV: Buffer): void {
    if (key.length !== OCB2AES128.BLOCK_SIZE) {
      throw new Error(`key must be exactly ${OCB2AES128.BLOCK_SIZE} bytes`);
    }
    if (encryptIV.length !== OCB2AES128.BLOCK_SIZE) {
      throw new Error(`encryptIV must be exactly ${OCB2AES128.BLOCK_SIZE} bytes`);
    }
    if (decryptIV.length !== OCB2AES128.BLOCK_SIZE) {
      throw new Error(`decryptIV must be exactly ${OCB2AES128.BLOCK_SIZE} bytes`);
    }

    this.key = Buffer.from(key);
    this.encryptIV = Buffer.from(encryptIV);
    this.decryptIV = Buffer.from(decryptIV);
  }

  /**
   * 加密数据
   */
  encrypt(plainText: Buffer): Buffer {
    if (!this.ready()) {
      throw new Error('Crypto not initialized');
    }

    // 递增加密IV
    const encryptIV = this.encryptIV;
    for (let i = 0; i < OCB2AES128.BLOCK_SIZE; i++) {
      if (++encryptIV[i] === 256) {
        encryptIV[i] = 0;
      } else {
        break;
      }
    }

    const cipher = createCipheriv('aes-128-ecb', this.key, Buffer.alloc(0)).setAutoPadding(false);

    const cipherText = Buffer.alloc(plainText.length + 4);
    const tag = this.ocbEncrypt(plainText, cipherText.slice(4), encryptIV, (data: Buffer) =>
      cipher.update(data)
    );

    cipherText[0] = encryptIV[0];
    cipherText[1] = tag[0];
    cipherText[2] = tag[1];
    cipherText[3] = tag[2];

    return cipherText;
  }

  /**
   * 解密数据
   */
  decrypt(cipherText: Buffer): { data: Buffer; valid: boolean } {
    if (!this.ready()) {
      throw new Error('Crypto not initialized');
    }

    if (cipherText.length < 4) {
      return { data: Buffer.alloc(0), valid: false };
    }

    const decryptIV = this.decryptIV;
    const saveiv = Buffer.from(decryptIV);
    const ivbyte = cipherText[0];
    let restore = false;
    let late = 0;
    let lost = 0;

    // 处理IV同步逻辑
    if (((decryptIV[0] + 1) & 0xff) === ivbyte) {
      // 按预期顺序
      if (ivbyte > decryptIV[0]) {
        decryptIV[0] = ivbyte;
      } else if (ivbyte < decryptIV[0]) {
        decryptIV[0] = ivbyte;
        for (let i = 1; i < OCB2AES128.BLOCK_SIZE; i++) {
          if (++decryptIV[i] === 256) {
            decryptIV[i] = 0;
          } else {
            break;
          }
        }
      } else {
        return { data: Buffer.alloc(0), valid: false };
      }
    } else {
      // 乱序或重复
      let diff = ivbyte - decryptIV[0];
      if (diff > 128) {
        diff = diff - 256;
      } else if (diff < -128) {
        diff = diff + 256;
      }

      if (ivbyte < decryptIV[0] && diff > -30 && diff < 0) {
        // 延迟包，但没有回绕
        late = 1;
        lost = -1;
        decryptIV[0] = ivbyte;
        restore = true;
      } else if (ivbyte > decryptIV[0] && diff > -30 && diff < 0) {
        // 延迟包，上一轮的0xff
        late = 1;
        lost = -1;
        decryptIV[0] = ivbyte;
        for (let i = 1; i < OCB2AES128.BLOCK_SIZE; i++) {
          if (--decryptIV[i] === -1) {
            decryptIV[i] = 255;
          } else {
            break;
          }
        }
        restore = true;
      } else if (ivbyte > decryptIV[0] && diff > 0) {
        // 丢失了一些包
        lost = ivbyte - decryptIV[0] - 1;
        decryptIV[0] = ivbyte;
      } else if (ivbyte < decryptIV[0] && diff > 0) {
        // 丢失了一些包，并且回绕
        lost = 256 - decryptIV[0] + ivbyte - 1;
        decryptIV[0] = ivbyte;
        for (let i = 1; i < OCB2AES128.BLOCK_SIZE; i++) {
          if (++decryptIV[i] === 256) {
            decryptIV[i] = 0;
          } else {
            break;
          }
        }
      } else {
        return { data: Buffer.alloc(0), valid: false };
      }

      if (this.decryptHistory[decryptIV[0]] === decryptIV[1]) {
        this.decryptIV = saveiv;
        return { data: Buffer.alloc(0), valid: false };
      }
    }

    const encrypt = createCipheriv('aes-128-ecb', this.key, Buffer.alloc(0)).setAutoPadding(false);
    const decrypt = createDecipheriv('aes-128-ecb', this.key, Buffer.alloc(0)).setAutoPadding(
      false
    );

    const plainText = Buffer.alloc(cipherText.length - 4);
    const tag = this.ocbDecrypt(
      cipherText.slice(4),
      plainText,
      decryptIV,
      (data: Buffer) => encrypt.update(data),
      (data: Buffer) => decrypt.update(data)
    );

    if (tag.compare(cipherText, 1, 4, 0, 3) !== 0) {
      this.decryptIV = saveiv;
      return { data: Buffer.alloc(0), valid: false };
    }

    this.decryptHistory[decryptIV[0]] = decryptIV[1];

    if (restore) {
      this.decryptIV = saveiv;
    }

    // 更新统计信息（参照 Go 实现 cryptstate.go 第241-248行）
    // 注意：这是本地接收统计，对应 Go 的 Good/Late/Lost，而不是 RemoteXXX
    this.localStats.good += 1;
    if (late > 0) {
      this.localStats.late += late;
    } else {
      // 处理负数情况（虽然通常不会发生）
      this.localStats.late -= -late;
    }
    // 注意：Lost 是赋值而不是累加（参照 Go 实现）
    if (lost > 0) {
      this.localStats.lost = lost;
    } else {
      this.localStats.lost = -lost;
    }
    this.lastGoodTime = Date.now();

    return { data: plainText, valid: true };
  }

  /**
   * OCB 加密
   */
  private ocbEncrypt(
    plainText: Buffer,
    cipherText: Buffer,
    nonce: Buffer,
    aesEncrypt: (data: Buffer) => Buffer
  ): Buffer {
    const checksum = Buffer.alloc(OCB2AES128.BLOCK_SIZE);
    const tmp = Buffer.alloc(OCB2AES128.BLOCK_SIZE);

    const delta = aesEncrypt(nonce);
    this.zero(checksum);

    let len = plainText.length;
    let plainOffset = 0;
    let cipherOffset = 0;

    while (len > OCB2AES128.BLOCK_SIZE) {
      this.s2(delta);
      this.xor(tmp, delta, plainText.slice(plainOffset));
      const encryptedTmp = aesEncrypt(tmp);
      this.xor(cipherText.slice(cipherOffset), delta, encryptedTmp);
      this.xor(checksum, checksum, plainText.slice(plainOffset));
      len -= OCB2AES128.BLOCK_SIZE;
      plainOffset += OCB2AES128.BLOCK_SIZE;
      cipherOffset += OCB2AES128.BLOCK_SIZE;
    }

    this.s2(delta);
    this.zero(tmp);
    tmp[OCB2AES128.BLOCK_SIZE - 1] = len * 8;
    this.xor(tmp, tmp, delta);
    const pad = aesEncrypt(tmp);
    plainText.slice(plainOffset, plainOffset + len).copy(tmp, 0, 0, len);
    pad.copy(tmp, len, len, OCB2AES128.BLOCK_SIZE);
    this.xor(checksum, checksum, tmp);
    this.xor(tmp, pad, tmp);
    tmp.copy(cipherText, cipherOffset, 0, len);

    this.s3(delta);
    this.xor(tmp, delta, checksum);
    const tag = aesEncrypt(tmp);

    return tag;
  }

  /**
   * OCB 解密
   */
  private ocbDecrypt(
    cipherText: Buffer,
    plainText: Buffer,
    nonce: Buffer,
    aesEncrypt: (data: Buffer) => Buffer,
    aesDecrypt: (data: Buffer) => Buffer
  ): Buffer {
    const checksum = Buffer.alloc(OCB2AES128.BLOCK_SIZE);
    const tmp = Buffer.alloc(OCB2AES128.BLOCK_SIZE);

    const delta = aesEncrypt(nonce);
    this.zero(checksum);

    let len = plainText.length;
    let plainOffset = 0;
    let cipherOffset = 0;

    while (len > OCB2AES128.BLOCK_SIZE) {
      this.s2(delta);
      this.xor(tmp, delta, cipherText.slice(cipherOffset));
      const decryptedTmp = aesDecrypt(tmp);
      this.xor(plainText.slice(plainOffset), delta, decryptedTmp);
      this.xor(checksum, checksum, plainText.slice(plainOffset));
      len -= OCB2AES128.BLOCK_SIZE;
      plainOffset += OCB2AES128.BLOCK_SIZE;
      cipherOffset += OCB2AES128.BLOCK_SIZE;
    }

    this.s2(delta);
    this.zero(tmp);
    tmp[OCB2AES128.BLOCK_SIZE - 1] = len * 8;
    this.xor(tmp, tmp, delta);
    const pad = aesEncrypt(tmp);
    this.zero(tmp);
    cipherText.slice(cipherOffset, cipherOffset + len).copy(tmp, 0, 0, len);
    this.xor(tmp, tmp, pad);
    this.xor(checksum, checksum, tmp);
    tmp.copy(plainText, plainOffset, 0, len);

    this.s3(delta);
    this.xor(tmp, delta, checksum);
    const tag = aesEncrypt(tmp);

    return tag;
  }

  /**
   * XOR 操作
   */
  private xor(dst: Buffer, a: Buffer, b: Buffer): void {
    for (let i = 0; i < OCB2AES128.BLOCK_SIZE; i++) {
      dst[i] = a[i] ^ b[i];
    }
  }

  /**
   * S2 操作: 左移1位并在进位时异或0x87
   */
  private s2(block: Buffer): void {
    const carry = block[0] >> 7;
    for (let i = 0; i < OCB2AES128.BLOCK_SIZE - 1; i++) {
      block[i] = (block[i] << 1) | (block[i + 1] >> 7);
    }
    block[OCB2AES128.BLOCK_SIZE - 1] = (block[OCB2AES128.BLOCK_SIZE - 1] << 1) ^ (carry * 0x87);
  }

  /**
   * S3 操作: XOR(block, block, S2(block))
   */
  private s3(block: Buffer): void {
    const carry = block[0] >> 7;
    for (let i = 0; i < OCB2AES128.BLOCK_SIZE - 1; i++) {
      block[i] ^= (block[i] << 1) | (block[i + 1] >> 7);
    }
    block[OCB2AES128.BLOCK_SIZE - 1] ^= (block[OCB2AES128.BLOCK_SIZE - 1] << 1) ^ (carry * 0x87);
  }

  /**
   * 清零操作
   */
  private zero(block: Buffer): void {
    block.fill(0, 0, OCB2AES128.BLOCK_SIZE);
  }

  /**
   * 获取当前密钥
   */
  getKey(): Buffer | undefined {
    return this.key ? Buffer.from(this.key) : undefined;
  }

  /**
   * 获取加密IV
   */
  getEncryptIV(): Buffer | undefined {
    return this.encryptIV ? Buffer.from(this.encryptIV) : undefined;
  }

  /**
   * 获取解密IV
   */
  getDecryptIV(): Buffer | undefined {
    return this.decryptIV ? Buffer.from(this.decryptIV) : undefined;
  }

  /**
   * 设置解密IV（用于重同步）
   */
  setDecryptIV(iv: Buffer): void {
    if (iv.length !== OCB2AES128.BLOCK_SIZE) {
      throw new Error(`IV must be exactly ${OCB2AES128.BLOCK_SIZE} bytes`);
    }
    this.decryptIV = Buffer.from(iv);
  }

  /**
   * 增加重同步计数
   */
  incrementResync(): void {
    this.localStats.resync += 1;
  }

  /**
   * 获取最后一次成功解密的时间
   */
  getLastGoodTime(): number {
    return this.lastGoodTime;
  }
}
