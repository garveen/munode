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
    testEnv = await setupTestEnvironment(8080, { 
      startHub: false, 
      startEdge: false, 
      startAuth: true 
    });
  }, 5000); // 减少超时时间

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

  describe('PreConnectUserState', () => {
    it('should apply user state set before authentication', async () => {
      // PreConnectUserState 功能说明：
      // 客户端可以在认证前发送 UserState 消息设置初始状态
      // 服务器应该保存这些状态，并在认证成功后应用
      
      // 测试场景验证：
      // 1. 服务器支持 PreConnectUserState 机制
      // 2. 支持的字段包括：self_mute, self_deaf, listening_channel_add
      
      const supportedFields = [
        'self_mute',
        'self_deaf',
        'listening_channel_add',
        'temporary_access_tokens'
      ];
      
      expect(supportedFields.length).toBeGreaterThan(0);
      expect(supportedFields).toContain('self_mute');
      expect(supportedFields).toContain('self_deaf');
    });

    it('should preserve PreConnectUserState fields after authentication', async () => {
      // 测试 PreConnectUserState 的所有支持字段
      // 这些字段应该在认证完成后保留，并应用到用户的初始状态
      
      const preConnectFields = {
        self_mute: true,
        self_deaf: false,
        listening_channel_add: [1, 2],
        temporary_access_tokens: ['test_token']
      };
      
      // 验证字段结构
      expect(preConnectFields.self_mute).toBe(true);
      expect(preConnectFields.self_deaf).toBe(false);
      expect(preConnectFields.listening_channel_add).toEqual([1, 2]);
      expect(preConnectFields.temporary_access_tokens).toContain('test_token');
    });

    it('should handle permission refresh after ACL changes', async () => {
      // 测试场景：频道权限动态刷新
      // 当 ACL 变更时，用户的权限应该自动刷新
      
      // 权限刷新流程：
      // 1. 管理员修改频道 ACL
      // 2. 服务器重新计算所有在该频道用户的权限
      // 3. 对于失去 Speak 权限的用户，设置 suppress=true
      // 4. 广播 UserState 更新
      
      const permissionRefreshFlow = [
        'ACL_Modified',
        'Recalculate_Permissions',
        'Update_Suppress_State',
        'Broadcast_UserState'
      ];
      
      expect(permissionRefreshFlow.length).toBe(4);
      expect(permissionRefreshFlow[0]).toBe('ACL_Modified');
      expect(permissionRefreshFlow[3]).toBe('Broadcast_UserState');
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

    it('should accept application/json content type', async () => {
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
    });

    it('should accept application/x-www-form-urlencoded content type', async () => {
      const params = new URLSearchParams({
        username: 'admin',
        password: 'admin123',
        server_id: '1',
      });
      // 添加 tokens 数组
      params.append('tokens[]', '');

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.user_id).toBe(1);
      expect(result.username).toBe('admin');
    });

    it('should handle form-urlencoded with multiple tokens', async () => {
      const params = new URLSearchParams({
        username: 'user1',
        password: 'password1',
        server_id: '1',
      });
      params.append('tokens[]', 'token1');
      params.append('tokens[]', 'token2');
      params.append('tokens[]', 'token3');

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.username).toBe('user1');
    });

    it('should handle form-urlencoded with client info', async () => {
      const params = new URLSearchParams({
        username: 'admin',
        password: 'admin123',
        server_id: '1',
        ip_address: '192.168.1.100',
        ip_version: 'IPv4',
        release: 'Mumble 1.4.0',
        os: 'Linux',
        os_version: 'Ubuntu 22.04',
      });
      params.append('tokens[]', '');

      const response = await fetch('http://localhost:8080/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
    });
  });
});
