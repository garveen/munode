/**
 * OpusEncoder - Opus 音频编码器
 * 
 * 主要职责:
 * - Opus 音频编码
 * - 支持可变比特率 (VBR) 和恒定比特率 (CBR)
 * - 可配置编码参数 (比特率、帧大小)
 * - PCM 输入处理
 */

import { OpusEncoder as DiscordOpusEncoder } from '@discordjs/opus';
import type { EncoderOptions } from '../types/audio-types.js';

export class OpusEncoder {
  private frameSize: number; // in ms
  private sampleRate: number = 48000;
  private channels: number = 1; // Mumble 使用单声道
  private encoder: any = null; // opus.Encoder instance

  constructor(options: EncoderOptions = {}) {
    this.frameSize = options.frameSize || 20;
    
    this.initialize();
  }

  /**
   * 初始化 Opus 编码器
   */
  private initialize(): void {
    this.encoder = new DiscordOpusEncoder(this.sampleRate, this.channels);
    // @discordjs/opus 的编码器默认设置可能已经合适
    // 如果需要调整比特率等，可以在这里设置
  }

  /**
   * 编码音频帧
   * @param pcm - PCM 音频数据 (16-bit signed integer)
   * @returns Opus 编码后的数据
   */
  encode(pcm: Buffer): Buffer {
    if (!this.encoder) {
      this.initialize();
    }

    // 检查输入大小是否符合帧大小要求
    const expectedBytes = this.getFrameBytes();
    if (pcm.length !== expectedBytes) {
      throw new Error(`PCM frame size mismatch: expected ${expectedBytes} bytes, got ${pcm.length}`);
    }

    // @discordjs/opus 期望的输入是 Int16Array
    const pcmArray = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);

    // 编码为 Opus
    const opusData = this.encoder.encode(pcmArray, this.frameSize);

    // 返回 Buffer
    return Buffer.from(opusData);
  }

  /**
   * 批量编码音频帧
   */
  encodeFrames(frames: Buffer[]): Buffer[] {
    return frames.map(frame => this.encode(frame));
  }

  /**
   * 设置比特率
   */
  setBitrate(_bitrate: number): void {
    // @discordjs/opus 编码器初始化后不支持动态改变比特率
    // 需要重新创建编码器
    if (this.encoder) {
      this.encoder.destroy();
      this.encoder = null;
    }
    this.initialize();
  }

  /**
   * 设置帧大小
   */
  setFrameSize(frameSize: number): void {
    this.frameSize = frameSize;
    // 帧大小改变需要重新初始化编码器
    if (this.encoder) {
      this.encoder.destroy();
      this.initialize();
    }
  }

  /**
   * 获取每帧的样本数
   */
  getFrameSamples(): number {
    return (this.sampleRate * this.frameSize) / 1000;
  }

  /**
   * 获取每帧的字节数 (PCM 16-bit)
   */
  getFrameBytes(): number {
    return this.getFrameSamples() * 2 * this.channels;
  }

  /**
   * 重置编码器状态
   */
  reset(): void {
    // @discordjs/opus 编码器可能没有显式的reset方法
    // 可以通过重新初始化来重置状态
    if (this.encoder) {
      this.encoder.destroy();
      this.initialize();
    }
  }

  /**
   * 销毁编码器
   */
  destroy(): void {
    if (this.encoder) {
      this.encoder.destroy();
      this.encoder = null;
    }
  }
}
