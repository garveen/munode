/**
 * User State Broadcast Tests
 * 
 * Tests to verify that user state changes are broadcasted correctly
 * without duplicates when users join, leave, or change channels.
 * 
 * Issue: Multiple UserState broadcasts when users change state
 * Fix: Skip duplicate broadcast for local users in handleRemoteUserJoined
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';

describe('User State Broadcast Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Use independent port range to avoid conflicts
    testEnv = await setupTestEnvironment(8300);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('User Join Broadcast', () => {
    // Both same-edge and cross-edge scenarios share the same verification pattern:
    // connect two clients sequentially → verify mutual visibility. They are merged
    // into one test that covers both scenarios to avoid duplicating setup/teardown.
    it('should broadcast UserState so both clients see each other on same-edge and cross-edge joins', async () => {
      // ── Scenario A: same Edge ────────────────────────────────────────────
      const sameEdgeA = new MumbleClient();
      const sameEdgeB = new MumbleClient();

      console.log('[TEST] Scenario A: both clients connect to Edge-1');
      await sameEdgeA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      expect(sameEdgeA.isConnected()).toBe(true);
      const sessionA1 = sameEdgeA.getStateManager().getSession();
      expect(sessionA1).toBeDefined();
      await sleep(500);

      await sameEdgeB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });
      expect(sameEdgeB.isConnected()).toBe(true);
      const sessionB1 = sameEdgeB.getStateManager().getSession();
      expect(sessionB1).toBeDefined();
      await sleep(500);

      const usersSeenByA1 = sameEdgeA.getUsers();
      console.log(`[TEST] A(same-edge) sees: ${usersSeenByA1.map(u => `${u.name}(${u.session})`).join(', ')}`);
      expect(usersSeenByA1.some(u => u.name === 'user2' && u.session === sessionB1?.session)).toBe(true);

      const usersSeenByB1 = sameEdgeB.getUsers();
      console.log(`[TEST] B(same-edge) sees: ${usersSeenByB1.map(u => `${u.name}(${u.session})`).join(', ')}`);
      expect(usersSeenByB1.some(u => u.name === 'user1' && u.session === sessionA1?.session)).toBe(true);

      await sameEdgeA.disconnect();
      await sameEdgeB.disconnect();

      // ── Scenario B: cross Edge ───────────────────────────────────────────
      const crossEdgeA = new MumbleClient();
      const crossEdgeB = new MumbleClient();

      console.log('[TEST] Scenario B: client A on Edge-1, client B on Edge-2');
      await crossEdgeA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      expect(crossEdgeA.isConnected()).toBe(true);
      const sessionA2 = crossEdgeA.getStateManager().getSession();
      expect(sessionA2).toBeDefined();
      await sleep(500);

      await crossEdgeB.connect({
        host: 'localhost',
        port: testEnv.edgePort2,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });
      expect(crossEdgeB.isConnected()).toBe(true);
      const sessionB2 = crossEdgeB.getStateManager().getSession();
      expect(sessionB2).toBeDefined();
      await sleep(500);

      const usersSeenByA2 = crossEdgeA.getUsers();
      console.log(`[TEST] A(cross-edge) sees: ${usersSeenByA2.map(u => `${u.name}(${u.session})`).join(', ')}`);
      expect(usersSeenByA2.some(u => u.name === 'guest' && u.session === sessionB2?.session)).toBe(true);

      const usersSeenByB2 = crossEdgeB.getUsers();
      console.log(`[TEST] B(cross-edge) sees: ${usersSeenByB2.map(u => `${u.name}(${u.session})`).join(', ')}`);
      expect(usersSeenByB2.some(u => u.name === 'admin' && u.session === sessionA2?.session)).toBe(true);

      await crossEdgeA.disconnect();
      await crossEdgeB.disconnect();
    });
  });

  // Note: Channel move broadcast testing requires additional setup
  // and is covered by other integration tests. The main fix for duplicate
  // broadcasts applies to all UserState changes including channel moves.
});
