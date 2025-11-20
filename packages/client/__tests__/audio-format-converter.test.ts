/**
 * Audio Format Converter Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioFormatConverter } from '../src/audio/format.js';

describe('AudioFormatConverter', () => {
  let converter: AudioFormatConverter;

  beforeEach(() => {
    converter = new AudioFormatConverter();
  });

  describe('Initialization', () => {
    it('should create converter instance', () => {
      expect(converter).toBeInstanceOf(AudioFormatConverter);
    });

    it('should create converter with custom ffmpeg path', () => {
      const customConverter = new AudioFormatConverter('/custom/ffmpeg');
      expect(customConverter).toBeDefined();
    });
  });

  describe('FFmpeg Availability', () => {
    it('should provide FFmpeg availability check', async () => {
      const isAvailable = await AudioFormatConverter.checkFFmpegAvailable();
      expect(typeof isAvailable).toBe('boolean');
    });
  });

  describe('Format Detection', () => {
    it('should provide format detection method', () => {
      expect(typeof converter.detectFormat).toBe('function');
    });
  });

  describe('Audio Conversion', () => {
    it('should provide PCM conversion method', () => {
      expect(typeof converter.convertToPCM).toBe('function');
    });

    it('should provide file conversion method', () => {
      expect(typeof converter.convertFromFile).toBe('function');
    });

    it('should provide URL conversion method', () => {
      expect(typeof converter.convertFromURL).toBe('function');
    });

    it('should provide buffer conversion method', () => {
      expect(typeof converter.convertFromBuffer).toBe('function');
    });

    it('should provide resampling method', () => {
      expect(typeof converter.resample).toBe('function');
    });
  });

  describe('Format Export', () => {
    it('should provide WAV export method', () => {
      expect(typeof converter.convertToWAV).toBe('function');
    });

    it('should provide Opus export method', () => {
      expect(typeof converter.convertToOpus).toBe('function');
    });
  });
});