/**
 * AudioFormatConverter - 音频格式转换器
 * 
 * 主要职责:
 * - 音频格式转换 (使用 FFmpeg)
 * - 支持多种输入格式 (WAV, MP3, OGG, FLAC, AAC)
 * - 重采样
 * - 格式检测
 */

import { spawn } from 'child_process';
import { Readable } from 'stream';
import type { AudioFormatOptions } from '../types/audio-types.js';

export class AudioFormatConverter {
  private ffmpegPath: string = 'ffmpeg';

  constructor(ffmpegPath?: string) {
    if (ffmpegPath) {
      this.ffmpegPath = ffmpegPath;
    }
  }

  /**
   * 转换音频格式到 PCM
   * @param input - 输入音频 (文件路径、URL 或 Buffer)
   * @param options - 转换选项
   * @returns PCM 音频流
   */
  async convertToPCM(
    input: string | Buffer,
    options: AudioFormatOptions = {}
  ): Promise<Readable> {
    if (typeof input === 'string') {
      // 文件路径或URL
      if (input.startsWith('http://') || input.startsWith('https://')) {
        return this.convertFromURL(input, options);
      } else {
        return this.convertFromFile(input, options);
      }
    } else {
      // Buffer
      return this.convertFromBuffer(input, options);
    }
  }

  /**
   * 从文件转换
   */
  async convertFromFile(
    filePath: string,
    options: AudioFormatOptions = {}
  ): Promise<Readable> {
    const sampleRate = options.sampleRate || 48000;
    const channels = options.channels || 1;
    
    const args = [
      '-i', filePath,
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channels.toString(),
      '-hide_banner',
      '-loglevel', 'error',
      'pipe:1'
    ];
    
    return this.spawnFFmpeg(args);
  }

  /**
   * 从 URL 转换
   */
  async convertFromURL(
    url: string,
    options: AudioFormatOptions = {}
  ): Promise<Readable> {
    const sampleRate = options.sampleRate || 48000;
    const channels = options.channels || 1;
    
    const args = [
      '-i', url,
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channels.toString(),
      '-hide_banner',
      '-loglevel', 'error',
      'pipe:1'
    ];
    
    return this.spawnFFmpeg(args);
  }

  /**
   * 从 Buffer 转换
   */
  async convertFromBuffer(
    buffer: Buffer,
    options: AudioFormatOptions = {}
  ): Promise<Readable> {
    const sampleRate = options.sampleRate || 48000;
    const channels = options.channels || 1;
    
    const args = [
      '-f', options.format || 'mp3',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channels.toString(),
      '-hide_banner',
      '-loglevel', 'error',
      'pipe:1'
    ];
    
    const ffmpeg = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
    
    return ffmpeg.stdout;
  }

  /**
   * 重采样 PCM 音频
   */
  async resample(
    input: Readable,
    inputRate: number,
    outputRate: number
  ): Promise<Readable> {
    const args = [
      '-f', 's16le',
      '-ar', inputRate.toString(),
      '-ac', '1',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', outputRate.toString(),
      '-ac', '1',
      '-hide_banner',
      '-loglevel', 'error',
      'pipe:1'
    ];
    
    const ffmpeg = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    input.pipe(ffmpeg.stdin);
    
    return ffmpeg.stdout;
  }

  /**
   * 检测音频格式
   */
  async detectFormat(input: string | Buffer): Promise<AudioFormatInfo> {
    return new Promise((resolve, reject) => {
      const args = [
        '-i', typeof input === 'string' ? input : 'pipe:0',
        '-f', 'ffmetadata',
        '-show_format',
        '-show_streams',
        '-print_format', 'json',
        'pipe:1'
      ];
      
      const ffprobe = spawn('ffprobe', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let output = '';
      let errorOutput = '';
      
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      ffprobe.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
          return;
        }
        
        try {
          const data = JSON.parse(output);
          const stream = data.streams?.[0];
          const format = data.format;
          
          if (!stream || !format) {
            reject(new Error('Invalid audio file'));
            return;
          }
          
          resolve({
            format: format.format_name || 'unknown',
            codec: stream.codec_name || 'unknown',
            sampleRate: parseInt(stream.sample_rate) || 0,
            channels: parseInt(stream.channels) || 0,
            bitrate: parseInt(format.bit_rate) || 0,
            duration: parseFloat(format.duration) || 0
          });
        } catch (error) {
          reject(new Error(`Failed to parse ffprobe output: ${error}`));
        }
      });
      
      ffprobe.on('error', (error) => {
        reject(error);
      });
      
      // 如果输入是Buffer，通过stdin传递
      if (Buffer.isBuffer(input)) {
        ffprobe.stdin.write(input);
        ffprobe.stdin.end();
      }
    });
  }

  /**
   * 转换为 WAV 格式
   */
  async convertToWAV(
    input: Readable,
    outputPath: string,
    options: AudioFormatOptions = {}
  ): Promise<void> {
    const sampleRate = options.sampleRate || 48000;
    const channels = options.channels || 1;
    
    const args = [
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channels.toString(),
      '-i', 'pipe:0',
      '-c:a', 'pcm_s16le',
      outputPath
    ];
    
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(this.ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      input.pipe(ffmpeg.stdin);
      
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 转换为 Opus 格式
   */
  async convertToOpus(
    input: Readable,
    outputPath: string,
    options: AudioFormatOptions = {}
  ): Promise<void> {
    const sampleRate = options.sampleRate || 48000;
    const channels = options.channels || 1;
    const bitrate = options.bitrate || 64000;
    
    const args = [
      '-f', 's16le',
      '-ar', sampleRate.toString(),
      '-ac', channels.toString(),
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', bitrate.toString(),
      outputPath
    ];
    
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(this.ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      input.pipe(ffmpeg.stdin);
      
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 启动 FFmpeg 进程
   */
  private spawnFFmpeg(args: string[]): Readable {
    const ffmpeg = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // 处理错误
    ffmpeg.stderr.on('data', (data) => {
      console.warn('FFmpeg stderr:', data.toString());
    });
    
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });
    
    return ffmpeg.stdout;
  }

  /**
   * 检查 FFmpeg 是否可用
   */
  static async checkFFmpegAvailable(ffmpegPath: string = 'ffmpeg'): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpeg = spawn(ffmpegPath, ['-version'], { stdio: 'ignore' });
      
      ffmpeg.on('close', (code) => {
        resolve(code === 0);
      });
      
      ffmpeg.on('error', () => {
        resolve(false);
      });
      
      // 超时处理
      setTimeout(() => {
        ffmpeg.kill();
        resolve(false);
      }, 5000);
    });
  }
}

/**
 * 音频格式信息
 */
export interface AudioFormatInfo {
  format: string;
  codec: string;
  sampleRate: number;
  channels: number;
  bitrate: number;
  duration: number;
}
