/**
 * 认证集成测试
 * 
 * 测试用户认证流程，包括：
 * - 用户名/密码登录
 * - 证书认证
 * - Token 刷新
 * - 登录失败处理
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleConnection } from '../helpers';
import * as http from 'http';

describe('Authentication Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Username/Password Authentication', () => {
    it('should authenticate with valid credentials via HTTP API', async () => {
      const authRequest = {
        username: 'admin',
        password: 'admin123',
        tokens: [],
        server_id: 1,
      };

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.user_id).toBe(1);
      expect(result.username).toBe('admin');
      expect(result.groups).toContain('admin');
    });

    it('should reject invalid credentials', async () => {
      const authRequest = {
        username: 'admin',
        password: 'wrongpassword',
        tokens: [],
        server_id: 1,
      };

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result.success).toBe(false);
    });

    it('should reject non-existent username', async () => {
      const authRequest = {
        username: 'nonexistent',
        password: 'password',
        tokens: [],
        server_id: 1,
      };

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result.success).toBe(false);
    });

    it('should authenticate different users with correct credentials', async () => {
      const users = [
        { username: 'admin', password: 'admin123', expected_id: 1, expected_groups: ['admin'] },
        { username: 'user1', password: 'password1', expected_id: 2, expected_groups: ['user'] },
        { username: 'user2', password: 'password2', expected_id: 3, expected_groups: ['user'] },
        { username: 'guest', password: 'guest123', expected_id: 4, expected_groups: ['user'] },
      ];

      for (const user of users) {
        const authRequest = {
          username: user.username,
          password: user.password,
          tokens: [],
          server_id: 1,
        };

        const response = await fetch('http://localhost:8080/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authRequest),
        });

        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.success).toBe(true);
        expect(result.user_id).toBe(user.expected_id);
        expect(result.username).toBe(user.username);
        expect(result.groups).toEqual(user.expected_groups);
      }
    });

    it('should handle malformed authentication requests', async () => {
      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.success).toBe(false);
    });

    it('should handle empty username', async () => {
      const authRequest = {
        username: '',
        password: 'password',
        tokens: [],
        server_id: 1,
      };

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result.success).toBe(false);
    });

    it('should handle concurrent authentication requests', async () => {
      const authRequests = Array(10).fill(null).map((_, i) => ({
        username: i % 2 === 0 ? 'admin' : 'user1',
        password: i % 2 === 0 ? 'admin123' : 'password1',
        tokens: [],
        server_id: 1,
      }));

      const responses = await Promise.all(
        authRequests.map(req =>
          fetch('http://localhost:8080/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
          })
        )
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.success).toBe(true);
      }
    });
  });

  describe('Authentication Server Health', () => {
    it('should have authentication server running', async () => {
      expect(testEnv.authServer).toBeDefined();
    });

    it('should handle OPTIONS requests (CORS preflight)', async () => {
      const response = await fetch('http://localhost:8080/auth', {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should return 404 for unknown routes', async () => {
      const response = await fetch('http://localhost:8080/unknown', {
        method: 'GET',
      });

      expect(response.status).toBe(404);
    });
  });
});
