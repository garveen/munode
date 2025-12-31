import { describe, it, expect } from 'vitest';
import { makeCompositeKey, parseCompositeKey, isValidCompositeKey, makeCompositeKeyFromContext } from '@munode/edge-server';

describe('composite-key', () => {
  describe('makeCompositeKey', () => {
    it('应该创建正确格式的复合键', () => {
      const key = makeCompositeKey('tenant1.example.com', 12345);
      expect(key).toBe('tenant1.example.com:12345');
    });

    it('应该处理不同的虚拟主机名', () => {
      const key1 = makeCompositeKey('host1', 1);
      const key2 = makeCompositeKey('host2', 1);
      expect(key1).toBe('host1:1');
      expect(key2).toBe('host2:1');
      expect(key1).not.toBe(key2);
    });

    it('应该处理不同的会话ID', () => {
      const key1 = makeCompositeKey('host1', 100);
      const key2 = makeCompositeKey('host1', 200);
      expect(key1).toBe('host1:100');
      expect(key2).toBe('host1:200');
      expect(key1).not.toBe(key2);
    });
  });

  describe('parseCompositeKey', () => {
    it('应该正确解析复合键', () => {
      const result = parseCompositeKey('tenant1.example.com:12345');
      expect(result).toEqual({
        vhostName: 'tenant1.example.com',
        sessionId: 12345,
      });
    });

    it('应该抛出错误当格式无效', () => {
      expect(() => parseCompositeKey('invalid')).toThrow('Invalid composite key format');
      expect(() => parseCompositeKey('too:many:parts')).toThrow('Invalid composite key format');
    });

    it('应该抛出错误当会话ID不是数字', () => {
      expect(() => parseCompositeKey('host:abc')).toThrow('Invalid session ID');
    });
  });

  describe('isValidCompositeKey', () => {
    it('应该验证有效的复合键', () => {
      expect(isValidCompositeKey('host:123')).toBe(true);
      expect(isValidCompositeKey('tenant.example.com:99999')).toBe(true);
    });

    it('应该拒绝无效的复合键', () => {
      expect(isValidCompositeKey('invalid')).toBe(false);
      expect(isValidCompositeKey('host:abc')).toBe(false);
      expect(isValidCompositeKey('too:many:parts')).toBe(false);
    });
  });

  describe('makeCompositeKeyFromContext', () => {
    it('应该与 makeCompositeKey 行为一致', () => {
      const key1 = makeCompositeKey('host', 123);
      const key2 = makeCompositeKeyFromContext('host', 123);
      expect(key1).toBe(key2);
    });
  });

  describe('往返转换', () => {
    it('应该能往返转换', () => {
      const vhostName = 'tenant1.example.com';
      const sessionId = 54321;
      
      const key = makeCompositeKey(vhostName, sessionId);
      const parsed = parseCompositeKey(key);
      
      expect(parsed.vhostName).toBe(vhostName);
      expect(parsed.sessionId).toBe(sessionId);
    });
  });
});
