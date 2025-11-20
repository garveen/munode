/**
 * Audio Mixer Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioMixer } from '../src/audio/stream.js';
import type { MixerOptions } from '../src/types/audio-types.js';

describe('AudioMixer', () => {
  let mixer: AudioMixer;
  let options: MixerOptions;

  beforeEach(() => {
    options = {
      sampleRate: 48000,
      channels: 1,
      volume: 1.0,
      filterMuted: false
    };
    mixer = new AudioMixer(options);
  });

  describe('Initialization', () => {
    it('should create mixer instance', () => {
      expect(mixer).toBeInstanceOf(AudioMixer);
    });
  });

  describe('Audio Input Management', () => {
    it('should provide audio input addition method', () => {
      expect(typeof mixer.addInput).toBe('function');
    });

    it('should handle audio input addition', () => {
      const testData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      mixer.addInput(1, testData);
      // Should not throw
    });
  });

  describe('Audio Mixing', () => {
    it('should provide mixing method', () => {
      expect(typeof mixer.mix).toBe('function');
    });

    it('should return null when no inputs', () => {
      const result = mixer.mix();
      expect(result).toBeNull();
    });

    it('should mix audio when inputs available', () => {
      const testData1 = Buffer.from([0x00, 0x10, 0x00, 0x10]); // 16-bit samples: 4096, 4096
      const testData2 = Buffer.from([0x00, 0x08, 0x00, 0x08]); // 16-bit samples: 2048, 2048

      mixer.addInput(1, testData1);
      mixer.addInput(2, testData2);

      const result = mixer.mix();
      expect(result).toBeInstanceOf(Buffer);
      expect(result!.length).toBe(4); // Same length as input
    });
  });

  describe('Output Management', () => {
    it('should provide output setting method', () => {
      expect(typeof mixer.setOutput).toBe('function');
    });
  });

  describe('Cleanup', () => {
    it('should provide destroy method', () => {
      expect(typeof mixer.destroy).toBe('function');
      mixer.destroy();
      // Should not throw
    });
  });
});