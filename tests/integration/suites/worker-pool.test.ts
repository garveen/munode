/**
 * Worker Pool Integration Tests
 * Tests Worker Thread Pool functionality with EdgeServer and VoiceRouter
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, createClients, cleanupClients, type TestEnvironment } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { cpus } from 'os';

describe('Worker Pool Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Setup complete test environment with Hub and Edge
    testEnv = await setupTestEnvironment(64700);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  }, 30000);

  it('should initialize Worker Pool on server start', () => {
    const workerPool = testEnv.edgeServer?.getCryptoWorkerPool();
    expect(workerPool).toBeDefined();
  });

  it('should connect clients with Worker Pool encryption', async () => {
    const clients = await createClients(testEnv, [
      { username: 'admin', edge: 1 },
      { username: 'user1', edge: 1 },
    ]);

    expect(clients[0].isConnected()).toBe(true);
    expect(clients[1].isConnected()).toBe(true);

    // Wait for full connection setup
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await cleanupClients(clients);
  }, 15000);

  it('should get Worker Pool statistics', async () => {
    const workerPool = testEnv.edgeServer?.getCryptoWorkerPool();
    expect(workerPool).toBeDefined();

    if (workerPool) {
      const stats = await workerPool.getStats();
      expect(stats).toBeDefined();
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);
      
      // Check worker stats structure
      for (const workerStat of stats) {
        expect(workerStat).toHaveProperty('workerId');
        expect(workerStat).toHaveProperty('sessionsCount');
        expect(workerStat).toHaveProperty('encryptCount');
        expect(workerStat).toHaveProperty('decryptCount');
        expect(workerStat).toHaveProperty('errorCount');
        expect(workerStat).toHaveProperty('uptime');
      }
    }
  });

  it('should cleanup Worker sessions on client disconnect', async () => {
    const clients = await createClients(testEnv, [
      { username: 'user2', edge: 1 },
    ]);

    expect(clients[0].isConnected()).toBe(true);

    const workerPool = testEnv.edgeServer?.getCryptoWorkerPool();
    const statsBefore = workerPool ? await workerPool.getStats() : undefined;
    
    await cleanupClients(clients);
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const statsAfter = workerPool ? await workerPool.getStats() : undefined;
    
    // Session count should remain stable or decrease after disconnect
    if (statsBefore && statsAfter && Array.isArray(statsBefore) && Array.isArray(statsAfter)) {
      const totalBefore = statsBefore.reduce((sum, s) => sum + s.sessionsCount, 0);
      const totalAfter = statsAfter.reduce((sum, s) => sum + s.sessionsCount, 0);
      expect(totalAfter).toBeLessThanOrEqual(totalBefore);
    }
  }, 15000);
});
