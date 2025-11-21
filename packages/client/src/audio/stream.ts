/**
 * AudioStreamManager - 音频流管理器
 * 
 * 主要职责:
 * - 管理音频输入输出流
 * - 音频流的启动、停止、暂停
 * - 支持多种输入源 (Stream, Buffer, File)
 * - 音频混音
 */

import { Readable, Writable } from 'stream';
import { OpusEncoder } from './encoder.js';
import type { AudioInput, AudioOutputStream as IAudioOutputStream, MixerOptions } from '../types/audio-types.js';
import type { MumbleClient } from '../core/mumble-client.js';

export class AudioStreamManager {
  private client: MumbleClient;
  private inputStream: AudioInputStream | null = null;
  private outputStreams: Map<number, AudioOutputStreamImpl> = new Map(); // session -> stream
  private mixer: AudioMixer | null = null;

  constructor(client: MumbleClient) {
    this.client = client;
  }

  /**
   * 开始音频输入流
   */
  async startInputStream(input: AudioInput): Promise<AudioInputStream> {
    // 创建输入流对象
    const encoder = new OpusEncoder({
      frameSize: 20,
      bitrate: 64000,
      vbr: true
    });

    const inputStream = new AudioInputStream(encoder, this.client);
    
    // 根据输入类型处理
    if (input instanceof Readable) {
      inputStream.start(input);
    } else if (Buffer.isBuffer(input)) {
      // 处理 Buffer 输入
      const readable = new Readable({
        read() {
          this.push(input);
          this.push(null);
        }
      });
      inputStream.start(readable);
    } else if (typeof input === 'string') {
      // 处理文件路径 (暂不支持)
      throw new Error('File input not implemented');
    }

    this.inputStream = inputStream;
    return inputStream;
  }

  /**
   * 停止音频输入流
   */
  async stopInputStream(): Promise<void> {
    if (this.inputStream) {
      this.inputStream.stop();
      this.inputStream = null;
    }
  }

  /**
   * 注册音频输出流 (接收特定用户的音频)
   */
  registerOutputStream(session: number): IAudioOutputStream {
    const outputStream = new AudioOutputStreamImpl(session);
    this.outputStreams.set(session, outputStream);
    return outputStream;
  }

  /**
   * 取消注册音频输出流
   */
  unregisterOutputStream(session: number): void {
    const stream = this.outputStreams.get(session);
    if (stream) {
      stream.destroy();
      this.outputStreams.delete(session);
    }
  }

  /**
   * 处理接收到的音频包
   */
  handleAudioPacket(session: number, audioData: Buffer): void {
    // 1. 解密音频包
    const decryptedData = this.client.getCryptoManager().decrypt(audioData);
    
    // 2. 获取输出流
    const outputStream = this.outputStreams.get(session);
    if (outputStream) {
      // 发送到输出流 (暂不解码)
      outputStream.receiveAudio(decryptedData);
    }
    
    // 3. 如果有混音器，也发送到混音器
    if (this.mixer) {
      this.mixer.addInput(session, decryptedData);
    }
  }

  /**
   * 创建混音器
   */
  createMixer(options: MixerOptions): AudioMixer {
    this.mixer = new AudioMixer(options);
    return this.mixer;
  }

  /**
   * 获取混音器
   */
  getMixer(): AudioMixer | null {
    return this.mixer;
  }

  /**
   * 清理所有流
   */
  cleanup(): void {
    this.stopInputStream();
    this.outputStreams.forEach(stream => stream.destroy());
    this.outputStreams.clear();
    if (this.mixer) {
      this.mixer.destroy();
      this.mixer = null;
    }
  }
}

/**
 * 音频输入流
 */
export class AudioInputStream {
  private source: Readable | null = null;
  private encoder: OpusEncoder;
  private client: MumbleClient;
  private sequenceNumber: number = 0;

  constructor(encoder: OpusEncoder, client: MumbleClient) {
    this.encoder = encoder;
    this.client = client;
  }

  /**
   * 启动输入流
   */
  start(source: Readable): void {
    this.source = source;
    
    // 绑定数据处理
    source.on('data', async (chunk: Buffer) => {
      try {
        // 编码音频数据
        const encoded = this.encoder.encode(chunk);
        
        // 发送音频帧
        await this.sendAudioFrame(encoded);
      } catch (error) {
        console.error('Error processing audio data:', error);
      }
    });

    source.on('end', () => {
      console.debug('Audio input stream ended');
    });

    source.on('error', (error) => {
      console.error('Audio input stream error:', error);
    });
  }

  /**
   * 发送音频帧
   */
  private async sendAudioFrame(encodedData: Buffer): Promise<void> {
    try {
      // 构建音频包
      const packet = this.buildVoicePacket(encodedData);
      
      // 加密包 (如果需要)
      const encryptedPacket = this.encryptPacket(packet);
      
      // 发送UDP包
      await this.sendUDPPacket(encryptedPacket);
      
      // 增加序列号
      this.sequenceNumber++;
    } catch (error) {
      console.error('Error sending audio frame:', error);
    }
  }

  /**
   * 构建语音包
   */
  private buildVoicePacket(audioData: Buffer): Buffer {
    // Mumble 语音包格式:
    // - 包头 (1字节): 音频类型 (bit 7-5) + 目标 (bit 4-0)
    // - Session ID (可变长度整数)
    // - Sequence Number (可变长度整数)
    // - 音频数据
    
    const sessionId = this.client.getStateManager().getSession()?.session || 0;
    const target = 0; // 默认目标 (普通语音)
    const codec = 4; // Opus = 4 (100 in binary)
    
    // 包头
    const header = (codec << 5) | target;
    
    // Session ID (Varint)
    const sessionVarint = this.encodeVarint(sessionId);
    
    // Sequence Number (Varint)
    const sequenceVarint = this.encodeVarint(this.sequenceNumber);
    
    // 组合包
    const packetSize = 1 + sessionVarint.length + sequenceVarint.length + audioData.length;
    const packet = Buffer.alloc(packetSize);
    
    let offset = 0;
    packet[offset++] = header;
    sessionVarint.copy(packet, offset);
    offset += sessionVarint.length;
    sequenceVarint.copy(packet, offset);
    offset += sequenceVarint.length;
    audioData.copy(packet, offset);
    
    return packet;
  }

  /**
   * 加密包
   */
  private encryptPacket(packet: Buffer): Buffer {
    // 使用客户端的加密管理器
    if (this.client.getCryptoManager().isInitialized()) {
      return this.client.getCryptoManager().encrypt(packet);
    }
    return packet;
  }

  /**
   * 发送语音包（UDP或TCP）
   */
  private async sendUDPPacket(packet: Buffer): Promise<void> {
    try {
      await this.client.getConnectionManager().sendVoicePacket(packet);
      console.debug(`Sent voice packet, size: ${packet.length}, sequence: ${this.sequenceNumber}`);
    } catch (error) {
      console.error('Failed to send voice packet:', error);
    }
  }

  /**
   * 编码可变长度整数 (Varint)
   */
  private encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    do {
      let byte = value & 0x7F;
      value >>= 7;
      if (value > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (value > 0);
    return Buffer.from(bytes);
  }

  /**
   * 停止输入流
   */
  stop(): void {
    if (this.source) {
      this.source.destroy();
      this.source = null;
    }
  }

  /**
   * 暂停输入流
   */
  pause(): void {
    if (this.source) {
      this.source.pause();
    }
  }

  /**
   * 恢复输入流
   */
  resume(): void {
    if (this.source) {
      this.source.resume();
    }
  }
}

/**
 * 音频输出流实现
 */
export class AudioOutputStreamImpl extends Writable implements IAudioOutputStream {
  session: number;

  constructor(session: number) {
    super();
    this.session = session;
    // 暂不初始化解码器，因为音频解码暂不实现
  }

  /**
   * 接收音频数据
   */
  receiveAudio(data: Buffer): void {
    // 暂不解码，直接写入流
    this.write(data);
  }
}
export class AudioMixer {
  private options: MixerOptions;
  private inputs: Map<number, Buffer[]> = new Map(); // session -> audio buffers
  private output: Writable | null = null;

  constructor(options: MixerOptions) {
    this.options = options;
  }

  /**
   * 添加音频输入
   */
  addInput(session: number, audioData: Buffer): void {
    if (!this.inputs.has(session)) {
      this.inputs.set(session, []);
    }
    
    const buffers = this.inputs.get(session)!;
    buffers.push(audioData);
    
    // 限制缓冲区大小，避免内存泄漏
    if (buffers.length > 100) {
      buffers.shift();
    }
  }

  /**
   * 混音并输出
   */
  mix(): Buffer | null {
    if (this.inputs.size === 0) {
      return null;
    }
    
    // 收集所有可用的音频数据
    const allBuffers: Buffer[] = [];
    for (const buffers of this.inputs.values()) {
      if (buffers.length > 0) {
        allBuffers.push(buffers.shift()!); // 使用并移除第一个缓冲区
      }
    }
    
    if (allBuffers.length === 0) {
      return null;
    }
    
    // 找到最大长度
    const maxLength = Math.max(...allBuffers.map(buf => buf.length));
    
    // 创建输出缓冲区
    const output = Buffer.alloc(maxLength);
    
    // 简单线性混音 (相加并平均)
    for (let i = 0; i < maxLength; i += 2) { // 16-bit samples
      let sum = 0;
      let count = 0;
      
      for (const buffer of allBuffers) {
        if (i < buffer.length) {
          const sample = buffer.readInt16LE(i);
          sum += sample;
          count++;
        }
      }
      
      // 平均值，避免削波
      const mixed = count > 0 ? Math.max(-32768, Math.min(32767, sum / count)) : 0;
      output.writeInt16LE(Math.round(mixed), i);
    }
    
    // 应用音量控制
    if (this.options.volume !== undefined && this.options.volume !== 1) {
      for (let i = 0; i < output.length; i += 2) {
        const sample = output.readInt16LE(i);
        const adjusted = Math.max(-32768, Math.min(32767, sample * this.options.volume));
        output.writeInt16LE(Math.round(adjusted), i);
      }
    }
    
    return output;
  }

  /**
   * 设置输出流
   */
  setOutput(output: Writable): void {
    this.output = output;
  }

  /**
   * 销毁混音器
   */
  destroy(): void {
    this.inputs.clear();
    if (this.output) {
      this.output.end();
      this.output = null;
    }
  }
}
