import crypto from 'crypto';

export interface VoicePacket {
  version: number;
  senderId: number;
  targetId: number;
  sequence: number;
  codec: number;
  data: Buffer;
}

export interface VoiceEncryptionConfig {
  algorithm: string; // 'aes-128-cbc' 或 'aes-256-cbc'
  key: Buffer;       // 加密密钥
}

export class VoiceChannel {
  private config: VoiceEncryptionConfig;

  constructor(config: VoiceEncryptionConfig) {
    this.config = config;
  }

  /**
   * Encode voice packet (with encryption)
   * Performance optimization: avoid multiple Buffer.concat
   */
  encodePacket(packet: VoicePacket): Buffer {
    // 编码明文包头 + 数据
    const plainBuffer = Buffer.allocUnsafe(14 + packet.data.length);
    plainBuffer.writeUInt8(packet.version, 0);
    plainBuffer.writeUInt32BE(packet.senderId, 1);
    plainBuffer.writeUInt32BE(packet.targetId, 5);
    plainBuffer.writeUInt32BE(packet.sequence, 9);
    plainBuffer.writeUInt8(packet.codec, 13);
    packet.data.copy(plainBuffer, 14);

    // 生成随机IV (16字节 for CBC)
    const iv = crypto.randomBytes(16);

    // 创建cipher
    const cipher = crypto.createCipheriv(this.config.algorithm, this.config.key, iv);

    // 加密整个包
    const encrypted1 = cipher.update(plainBuffer);
    const encrypted2 = cipher.final();

    // Performance optimization: direct buffer assembly to avoid multiple Buffer.concat
    // Return format: IV(16) + encrypted data
    const totalSize = 16 + encrypted1.length + encrypted2.length;
    const result = Buffer.allocUnsafe(totalSize);
    iv.copy(result, 0);
    encrypted1.copy(result, 16);
    encrypted2.copy(result, 16 + encrypted1.length);
    
    return result;
  }

  /**
   * Decode voice packet (with decryption)
   * Performance optimization: avoid Buffer.concat
   */
  decodePacket(buffer: Buffer): VoicePacket | null {
    if (buffer.length < 16 + 14) return null; // IV + 最小包头

    try {
      const iv = buffer.slice(0, 16);
      const encryptedData = buffer.slice(16);

      // 创建decipher
      const decipher = crypto.createDecipheriv(this.config.algorithm, this.config.key, iv);

      // Decrypt data
      // Performance optimization: direct buffer assembly to avoid Buffer.concat
      const decrypted1 = decipher.update(encryptedData);
      const decrypted2 = decipher.final();
      const decryptedData = Buffer.allocUnsafe(decrypted1.length + decrypted2.length);
      decrypted1.copy(decryptedData, 0);
      decrypted2.copy(decryptedData, decrypted1.length);

      // 验证解密后的数据长度
      if (decryptedData.length < 14) return null;

      // 解析包头
      return {
        version: decryptedData.readUInt8(0),
        senderId: decryptedData.readUInt32BE(1),
        targetId: decryptedData.readUInt32BE(5),
        sequence: decryptedData.readUInt32BE(9),
        codec: decryptedData.readUInt8(13),
        data: decryptedData.slice(14),
      };
    } catch (_error) {
      // 解密失败，返回null
      return null;
    }
  }

  /**
   * 生成新的加密配置（用于密钥分发）
   */
  static generateEncryptionConfig(algorithm: 'aes-128-cbc' | 'aes-256-cbc' = 'aes-128-cbc'): VoiceEncryptionConfig {
    const keyLength = algorithm === 'aes-128-cbc' ? 16 : 32;
    const key = crypto.randomBytes(keyLength);

    return {
      algorithm,
      key,
    };
  }

  /**
   * 从密钥数据创建配置
   */
  static createEncryptionConfig(algorithm: string, keyData: Buffer): VoiceEncryptionConfig {
    return {
      algorithm,
      key: keyData,
    };
  }

  /**
   * 更新加密密钥
   */
  updateKey(key: Buffer): void {
    this.config.key = key;
  }
}