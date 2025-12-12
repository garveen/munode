import { createCipheriv, createDecipheriv, randomBytes, Cipher, Decipher } from 'crypto';

/**
 * OCB2-AES128 加密模式实现
 * 基于 mumble-streams 的实现，与 Mumble 协议兼容
 *
 * 原始实现来源: https://github.com/Johni0702/mumble-streams/blob/master/lib/udp-crypto.js
 * 版权声明: Copyright 2005-2016 The Mumble Developers. All rights reserved.
 * 
 * 性能优化：
 * - 复用 Cipher/Decipher 实例，避免每次加解密创建新对象
 * - 预分配工作 Buffer，减少 GC 压力
 * - 使用 BigUint64 批量 XOR 操作
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
  private static readonly ZERO_IV = Buffer.alloc(0);
  private lastGoodTime: number = Date.now();

  // 缓存的 Cipher 实例（性能优化：避免每次加解密创建新实例）
  private encryptCipher?: Cipher;
  private decryptCipherEnc?: Cipher;
  private decryptCipherDec?: Decipher;

  // 预分配的工作 Buffer（性能优化：减少 GC 压力）
  private readonly workBuffer = {
    checksum: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
    tmp: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
    saveiv: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
  };

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
    this.key = buf.subarray(0, OCB2AES128.BLOCK_SIZE);
    this.decryptIV = buf.subarray(OCB2AES128.BLOCK_SIZE, OCB2AES128.BLOCK_SIZE * 2);
    this.encryptIV = buf.subarray(OCB2AES128.BLOCK_SIZE * 2);
    
    // 初始化 cipher 实例
    this.initCiphers();
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
    
    // 创建并缓存 Cipher 实例（性能优化）
    this.initCiphers();
  }

  /**
   * 初始化/重新初始化 Cipher 实例
   * 在设置 key 或重新同步时调用
   */
  private initCiphers(): void {
    if (!this.key) return;
    
    this.encryptCipher = createCipheriv('aes-128-ecb', this.key, OCB2AES128.ZERO_IV)
      .setAutoPadding(false);
    this.decryptCipherEnc = createCipheriv('aes-128-ecb', this.key, OCB2AES128.ZERO_IV)
      .setAutoPadding(false);
    this.decryptCipherDec = createDecipheriv('aes-128-ecb', this.key, OCB2AES128.ZERO_IV)
      .setAutoPadding(false);
  }

  /**
   * 加密数据
   * 性能优化：使用 Buffer.allocUnsafe 减少初始化开销（数据会被完全覆盖）
   */
  encrypt(plainText: Buffer): Buffer {
    if (!this.ready() || !this.encryptCipher) {
      throw new Error('Crypto not initialized');
    }

    // 递增加密IV
    const encryptIV = this.encryptIV!;
    for (let i = 0; i < OCB2AES128.BLOCK_SIZE; i++) {
      if (++encryptIV[i] === 256) {
        encryptIV[i] = 0;
      } else {
        break;
      }
    }

    // 复用缓存的 cipher 实例
    const aesEncrypt = (data: Buffer) => this.encryptCipher!.update(data);

    // 性能优化：使用 allocUnsafe，数据会被完全填充
    const cipherText = Buffer.allocUnsafe(plainText.length + 4);
    const tag = this.ocbEncrypt(plainText, cipherText.subarray(4), encryptIV, aesEncrypt);

    cipherText[0] = encryptIV[0];
    cipherText[1] = tag[0];
    cipherText[2] = tag[1];
    cipherText[3] = tag[2];

    return cipherText;
  }

  /**
   * 解密数据
   * 性能优化：使用 Buffer.allocUnsafe 减少初始化开销（数据会被完全覆盖）
   */
  decrypt(cipherText: Buffer): { data: Buffer; valid: boolean } {
    if (!this.ready() || !this.decryptCipherEnc || !this.decryptCipherDec) {
      throw new Error('Crypto not initialized');
    }

    if (cipherText.length < 4) {
      return { data: Buffer.allocUnsafe(0), valid: false };
    }

    const decryptIV = this.decryptIV;
    // 使用预分配的 saveiv buffer
    const saveiv = this.workBuffer.saveiv;
    decryptIV.copy(saveiv);
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
        saveiv.copy(this.decryptIV);
        return { data: Buffer.alloc(0), valid: false };
      }
    }

    // 复用缓存的 cipher 实例
    const aesEncrypt = (data: Buffer) => this.decryptCipherEnc!.update(data);
    const aesDecrypt = (data: Buffer) => this.decryptCipherDec!.update(data);

    // 性能优化：使用 allocUnsafe，数据会被 ocbDecrypt 完全覆盖
    const plainText = Buffer.allocUnsafe(cipherText.length - 4);
    const tag = this.ocbDecrypt(
      cipherText.subarray(4),
      plainText,
      decryptIV,
      aesEncrypt,
      aesDecrypt
    );

    if (tag.compare(cipherText, 1, 4, 0, 3) !== 0) {
      saveiv.copy(this.decryptIV);
      return { data: Buffer.allocUnsafe(0), valid: false };
    }

    this.decryptHistory[decryptIV[0]] = decryptIV[1];

    if (restore) {
      saveiv.copy(this.decryptIV);
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
   * 性能优化：复用预分配的工作 Buffer
   */
  private ocbEncrypt(
    plainText: Buffer,
    cipherText: Buffer,
    nonce: Buffer,
    aesEncrypt: (data: Buffer) => Buffer
  ): Buffer {
    // 复用预分配的 Buffer，减少 GC 压力
    const checksum = this.workBuffer.checksum;
    const tmp = this.workBuffer.tmp;

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
   * 性能优化：复用预分配的工作 Buffer
   */
  private ocbDecrypt(
    cipherText: Buffer,
    plainText: Buffer,
    nonce: Buffer,
    aesEncrypt: (data: Buffer) => Buffer,
    aesDecrypt: (data: Buffer) => Buffer
  ): Buffer {
    // 复用预分配的 Buffer，减少 GC 压力
    const checksum = this.workBuffer.checksum;
    const tmp = this.workBuffer.tmp;

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
   * 性能优化：使用直接的循环展开，避免 DataView 创建开销
   * 16 字节展开为 16 个直接操作，编译器可以更好地优化
   */
  private xor(dst: Buffer, a: Buffer, b: Buffer): void {
    // 循环展开优化：16字节直接展开
    // V8 JIT 可以更好地优化展开的循环
    dst[0] = a[0] ^ b[0];
    dst[1] = a[1] ^ b[1];
    dst[2] = a[2] ^ b[2];
    dst[3] = a[3] ^ b[3];
    dst[4] = a[4] ^ b[4];
    dst[5] = a[5] ^ b[5];
    dst[6] = a[6] ^ b[6];
    dst[7] = a[7] ^ b[7];
    dst[8] = a[8] ^ b[8];
    dst[9] = a[9] ^ b[9];
    dst[10] = a[10] ^ b[10];
    dst[11] = a[11] ^ b[11];
    dst[12] = a[12] ^ b[12];
    dst[13] = a[13] ^ b[13];
    dst[14] = a[14] ^ b[14];
    dst[15] = a[15] ^ b[15];
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
