/**
 * Audio Types - 音频相关类型定义
 */

import { Readable, Writable } from 'stream';

/**
 * 编码器选项
 */
export interface EncoderOptions {
  /** 比特率 (bps) */
  bitrate?: number;
  
  /** 帧大小 (ms) */
  frameSize?: number;
  
  /** 是否使用可变比特率 */
  vbr?: boolean;
}

/**
 * 音频输入
 */
export interface AudioInput {
  /** 音频数据 (Buffer, Stream, 或文件路径) */
  data: Buffer | Readable | string;
  
  /** 音频格式 */
  format?: 'raw' | 'opus' | 'auto';
  
  /** 编解码器 */
  codec?: 'opus' | 'passthrough' | 'auto-detect';
  
  /** 编码器选项 */
  encoder?: EncoderOptions;
}

/**
 * 音频输出流
 */
export interface AudioOutputStream extends Writable {
  session: number;
  destroy(): this;
}

/**
 * 音频帧
 */
export interface AudioFrame {
  /** 音频数据 */
  data: Buffer;
  
  /** 序列号 */
  sequence: number;
  
  /** 编解码器 */
  codec: 'opus';
  
  /** 时间戳 */
  timestamp?: number;
}

/**
 * 混音器选项
 */
export interface MixerOptions {
  /** 输出采样率 */
  sampleRate?: number;
  
  /** 输出声道数 */
  channels?: number;
  
  /** 音量 (0-1) */
  volume?: number;
  
  /** 是否过滤静音用户 */
  filterMuted?: boolean;
}

/**
 * 音频格式选项
 */
export interface AudioFormatOptions {
  /** 采样率 */
  sampleRate?: number;
  
  /** 声道数 */
  channels?: number;
  
  /** 比特率 */
  bitrate?: number;
  
  /** 格式 */
  format?: string;
}
