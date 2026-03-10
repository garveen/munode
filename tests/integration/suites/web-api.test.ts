/**
 * Hub Web API 集成测试
 *
 * 测试场景：
 * 1. GET /api/health  — 健康检查
 * 2. GET /api/status  — Hub 状态信息
 * 3. GET /api/edges   — Edge 列表
 * 4. GET /api/edges/:id — 特定 Edge 详情（404 测试）
 * 5. GET /api/stats   — Hub 统计数据
 * 6. GET /api/topology — 网络拓扑
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, cleanupClients, createClients, USE_RUST } from '../setup.js';
import type { TestEnvironment } from '../setup.js';

/** 跳过 TS 模式 — Web API 仅在 Rust Hub 中实现 */
describe.skipIf(!USE_RUST)('Hub Web API Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(15600, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
    });
    // 等待 Edge 注册到 Hub
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 30000);

  afterAll(async () => {
    await testEnv.cleanup();
  }, 30000);

  /**
   * 向 Web API 发起 GET 请求
   */
  async function webApiGet(path: string): Promise<{ status: number; body: unknown }> {
    const url = `http://127.0.0.1:${testEnv.webApiPort}${path}`;
    const res = await fetch(url);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response (e.g. 404 empty body) — leave body as null
    }
    return { status: res.status, body };
  }

  describe('Health Check', () => {
    it('GET /api/health should return 200 OK', async () => {
      const { status, body } = await webApiGet('/api/health');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true });
    }, 5000);
  });

  describe('Status', () => {
    it('GET /api/status should return hub status', async () => {
      const { status, body } = await webApiGet('/api/status');
      expect(status).toBe(200);
      const s = body as Record<string, unknown>;
      expect(s.status).toBe('running');
      expect(typeof s.version).toBe('string');
      expect(typeof s.uptime_secs).toBe('number');
      expect(typeof s.timestamp).toBe('number');
      expect(typeof s.edge_count).toBe('number');
      expect(typeof s.session_count).toBe('number');
    }, 5000);

    it('GET /api/status should report at least 1 connected edge', async () => {
      const { body } = await webApiGet('/api/status');
      const s = body as Record<string, unknown>;
      // Edge 1 已注册
      expect(s.edge_count).toBeGreaterThanOrEqual(1);
    }, 5000);
  });

  describe('Edge List', () => {
    it('GET /api/edges should return array of edges', async () => {
      const { status, body } = await webApiGet('/api/edges');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      const edges = body as Array<Record<string, unknown>>;
      expect(edges.length).toBeGreaterThanOrEqual(1);
    }, 5000);

    it('each edge entry has required fields', async () => {
      const { body } = await webApiGet('/api/edges');
      const edges = body as Array<Record<string, unknown>>;
      for (const edge of edges) {
        expect(typeof edge.id).toBe('number');
        expect(typeof edge.name).toBe('string');
        expect(typeof edge.host).toBe('string');
        expect(typeof edge.port).toBe('number');
        expect(typeof edge.capacity).toBe('number');
        expect(typeof edge.is_online).toBe('boolean');
      }
    }, 5000);
  });

  describe('Edge Detail', () => {
    it('GET /api/edges/:id should return 404 for unknown edge', async () => {
      const { status } = await webApiGet('/api/edges/999999');
      expect(status).toBe(404);
    }, 5000);

    it('GET /api/edges/:id should return edge detail for a known edge', async () => {
      // 先获取 edge 列表，取第一个 ID
      const { body: list } = await webApiGet('/api/edges');
      const edges = list as Array<Record<string, unknown>>;
      // 至少一个 Edge 应该已注册（beforeAll 中等待了 1500ms）
      expect(edges.length).toBeGreaterThanOrEqual(1);

      const edgeId = edges[0].id as number;
      const { status, body } = await webApiGet(`/api/edges/${edgeId}`);
      expect(status).toBe(200);
      const detail = body as Record<string, unknown>;
      expect(detail.id).toBe(edgeId);
      expect(typeof detail.name).toBe('string');
      expect(typeof detail.connected_peer_ids).toBe('object'); // array
    }, 5000);
  });

  describe('Stats', () => {
    it('GET /api/stats should return statistics', async () => {
      const { status, body } = await webApiGet('/api/stats');
      expect(status).toBe(200);
      const s = body as Record<string, unknown>;
      expect(typeof s.total_sessions).toBe('number');
      expect(typeof s.total_channels).toBe('number');
      expect(typeof s.total_edges).toBe('number');
      expect(typeof s.timestamp).toBe('number');
    }, 5000);

    it('GET /api/stats sessions increases when client connects', async () => {
      const { body: before } = await webApiGet('/api/stats');
      const statsBefore = before as Record<string, unknown>;
      const sessionsBefore = statsBefore.total_sessions as number;

      // 连接一个客户端
      const clients = await createClients(testEnv, [{ username: 'user1', edge: 1 }]);

      await new Promise((resolve) => setTimeout(resolve, 800));

      const { body: after } = await webApiGet('/api/stats');
      const statsAfter = after as Record<string, unknown>;
      expect(statsAfter.total_sessions as number).toBeGreaterThan(sessionsBefore);

      await cleanupClients(clients);
    }, 15000);
  });

  describe('Topology', () => {
    it('GET /api/topology should return edges and links', async () => {
      const { status, body } = await webApiGet('/api/topology');
      expect(status).toBe(200);
      const t = body as Record<string, unknown>;
      expect(Array.isArray(t.edges)).toBe(true);
      expect(Array.isArray(t.links)).toBe(true);
      expect(typeof t.timestamp).toBe('number');
    }, 5000);
  });

  describe('Unknown Endpoints', () => {
    it('unknown path should return 404', async () => {
      const url = `http://127.0.0.1:${testEnv.webApiPort}/api/nonexistent`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
    }, 5000);
  });
});
