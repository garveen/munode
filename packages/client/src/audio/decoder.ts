/**
 * OpusDecoder - Opus 音频解码器
 * 
 * 注意: 当前实现不需要解码功能，仅提供接口兼容性
 */

export class OpusDecoder {
  constructor(_sampleRate: number = 48000) {
    // 不初始化解码器，因为不需要解码
  }

  /**
   * 解码音频帧 - 不实现
   */
  decode(_opusData: Buffer): Buffer {
    throw new Error('Opus decoding is not implemented');
  }

  /**
   * 解码丢失的帧 - 不实现
   */
  decodeLost(_frameSize: number): Buffer {
    throw new Error('Opus decoding is not implemented');
  }

  /**
   * 批量解码音频帧 - 不实现
   */
  decodeFrames(_frames: Buffer[]): Buffer[] {
    throw new Error('Opus decoding is not implemented');
  }

  /**
   * 获取解码器延迟
   */
  getDelay(): number {
    return 0;
  }

  /**
   * 重置解码器状态
   */
  reset(): void {
    // 无操作
  }

  /**
   * 销毁解码器
   */
  destroy(): void {
    // 无操作
  }
}

/**
 * 自动检测并创建解码器
 */
export class AudioDecoderFactory {
  /**
   * 根据音频包头自动检测编码格式并创建解码器
   */
  static createDecoder(audioPacket: Buffer): OpusDecoder {
    // Mumble 音频包格式:
    // - 第一个字节包含音频类型和目标
    // - 目前 Mumble 客户端和服务器之间只使用 Opus 编码
    const codec = this.detectCodec(audioPacket);
    if (codec === 'opus') {
      return new OpusDecoder();
    }
    throw new Error(`Unsupported codec: ${codec}`);
  }

  /**
   * 检测音频包的编码格式
   */
  static detectCodec(audioPacket: Buffer): 'opus' | 'unknown' {
    // Mumble 音频包第一个字节的高 3 位表示音频类型
    // 000 = CELT Alpha
    // 001 = Ping
    // 010 = Speex
    // 011 = CELT Beta
    // 100 = Opus
    if (audioPacket.length < 1) {
      return 'unknown';
    }
    const type = (audioPacket[0] >> 5) & 0x07;
    return type === 0b100 ? 'opus' : 'unknown';
  }
}
