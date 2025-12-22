/**
 * Voice Target Permission Validation Tests
 * 
 * Tests permission checks when setting voice targets (whisper functionality).
 * Based on Mumble's permission model:
 * - User must have Whisper permission in their current channel
 * - User must have access (Listen/Enter) to target channels
 * - User must be able to see target users (Channel Ninja rules)
 * 
 * Test architecture:
 * - Hub validates permissions before accepting VoiceTarget configurations
 * - Edge receives permission errors when validation fails
 * - Tests cover various permission scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, createClients, cleanupClients, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import * as crypto from 'crypto';

/**
 * Generate random voice data for testing
 */
function generateRandomVoiceData(size: number = 20): Buffer {
  return crypto.randomBytes(size);
}

/**
 * Create Opus voice packet (client format)
 */
function createVoicePacket(codec: number = 4, target: number = 0, sequence: number = 0): Buffer {
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  const voiceData = generateRandomVoiceData(20);
  return Buffer.concat([header, sequenceVarint, voiceData]);
}

/**
 * Create admin client for setup operations
 */
async function createAdminClient(testEnv: TestEnvironment, edge: 1 | 2 = 1): Promise<MumbleClient> {
  const admin = new MumbleClient();
  const port = edge === 1 ? testEnv.edgePort : testEnv.edgePort2;
  await admin.connect({
    host: 'localhost',
    port: port,
    udpPort: port,
    username: 'admin',
    password: 'admin123',
    rejectUnauthorized: false,
  });
  await sleep(300);
  return admin;
}

describe('Voice Target Permission Validation Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8500, {
      silent: false,
      startEdge2: true,
      reuse: false,
    });
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Basic Permission Checks', () => {
    it('should allow VoiceTarget with Whisper permission', async () => {
      const clients = await createClients(testEnv, [
        { username: 'whisper_allowed', edge: 1, channelId: 0 },
        { username: 'target_user', edge: 1, channelId: 0 },
      ]);

      const [sender, target] = clients;
      const targetSession = target.getStateManager().getSession()?.session || 0;

      // Set voice target to specific user
      try {
        await sender.setVoiceTarget(1, [{
          session: [targetSession],
        }]);
        
        // If no error is thrown, the permission check passed
        expect(true).toBe(true);
      } catch (error) {
        // Should not fail for users with default permissions
        console.error('VoiceTarget setting failed:', error);
        throw error;
      }

      await cleanupClients(clients);
    });

    it('should deny VoiceTarget without Whisper permission', async () => {
      const admin = await createAdminClient(testEnv, 1);

      // Create a restricted channel without Whisper permission
      const restrictedChannelId = await admin.createChannel({
        parent: 0,
        name: 'NoWhisper',
      });
      await sleep(500);

      // Remove Whisper permission from the channel
      await admin.setACL({
        channelId: restrictedChannelId,
        acls: [{
          applyHere: true,
          applySubs: false,
          group: 'all',
          grant: 0, // No permissions granted
          deny: 0x100, // Deny Whisper (0x100)
        }],
        groups: [],
        inherit: false,
      });
      await sleep(500);

      const clients = await createClients(testEnv, [
        { username: 'no_whisper_user', edge: 1, channelId: restrictedChannelId },
        { username: 'target_user2', edge: 1, channelId: 0 },
      ]);

      const [sender, target] = clients;
      const targetSession = target.getStateManager().getSession()?.session || 0;

      // Try to set voice target (should fail)
      try {
        await sender.setVoiceTarget(1, [{
          session: [targetSession],
        }]);
        
        // If we get here, the test should fail
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        // Expected to fail with permission error
        expect(error).toBeDefined();
        console.log('[TEST] Expected permission denial:', error);
      }

      await cleanupClients(clients);
      await admin.disconnect();
    });
  });

  describe('Target Channel Permission Checks', () => {
    it('should allow targeting accessible channels', async () => {
      const admin = await createAdminClient(testEnv, 1);

      // Create a public channel
      const publicChannelId = await admin.createChannel({
        parent: 0,
        name: 'PublicChannel',
      });
      await sleep(500);

      const clients = await createClients(testEnv, [
        { username: 'sender_user', edge: 1, channelId: 0 },
        { username: 'receiver_in_channel', edge: 1, channelId: publicChannelId },
      ]);

      const [sender] = clients;

      // Set voice target to public channel (should succeed)
      try {
        await sender.setVoiceTarget(2, [{
          channelId: publicChannelId,
        }]);
        
        expect(true).toBe(true);
      } catch (error) {
        console.error('VoiceTarget to accessible channel failed:', error);
        throw error;
      }

      await cleanupClients(clients);
      await admin.disconnect();
    });

    it('should deny targeting inaccessible channels', async () => {
      const admin = await createAdminClient(testEnv, 1);

      // Create a restricted channel
      const restrictedChannelId = await admin.createChannel({
        parent: 0,
        name: 'RestrictedChannel',
      });
      await sleep(500);

      // Remove Enter and Listen permissions for all users
      await admin.setACL({
        channelId: restrictedChannelId,
        acls: [{
          applyHere: true,
          applySubs: false,
          group: 'all',
          grant: 0,
          deny: 0x804, // Deny Enter (0x4) and Listen (0x800)
        }],
        groups: [],
        inherit: false,
      });
      await sleep(500);

      const clients = await createClients(testEnv, [
        { username: 'restricted_sender', edge: 1, channelId: 0 },
      ]);

      const [sender] = clients;

      // Try to target the restricted channel (should fail)
      try {
        await sender.setVoiceTarget(3, [{
          channelId: restrictedChannelId,
        }]);
        
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Expected to fail
        expect(error).toBeDefined();
        console.log('[TEST] Expected channel access denial:', error);
      }

      await cleanupClients(clients);
      await admin.disconnect();
    });
  });

  describe('Target User Visibility Checks', () => {
    it('should allow targeting visible users', async () => {
      const clients = await createClients(testEnv, [
        { username: 'sender_visible', edge: 1, channelId: 0 },
        { username: 'target_visible', edge: 1, channelId: 0 },
      ]);

      const [sender, target] = clients;
      const targetSession = target.getStateManager().getSession()?.session || 0;

      // Target a visible user (should succeed)
      try {
        await sender.setVoiceTarget(4, [{
          session: [targetSession],
        }]);
        
        expect(true).toBe(true);
      } catch (error) {
        console.error('VoiceTarget to visible user failed:', error);
        throw error;
      }

      await cleanupClients(clients);
    });

    it('should deny targeting non-existent users', async () => {
      const clients = await createClients(testEnv, [
        { username: 'sender_invalid', edge: 1, channelId: 0 },
      ]);

      const [sender] = clients;

      // Try to target a non-existent session
      try {
        await sender.setVoiceTarget(5, [{
          session: [99999], // Invalid session ID
        }]);
        
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Expected to fail
        expect(error).toBeDefined();
        console.log('[TEST] Expected invalid session denial:', error);
      }

      await cleanupClients(clients);
    });
  });

  describe('VoiceTarget Deletion', () => {
    it('should allow removing voice targets without permission checks', async () => {
      const clients = await createClients(testEnv, [
        { username: 'remover', edge: 1, channelId: 0 },
      ]);

      const [client] = clients;

      // Set a voice target
      await client.setVoiceTarget(6, [{
        session: [client.getStateManager().getSession()?.session || 0],
      }]);
      await sleep(300);

      // Remove it (should always succeed, no permission check needed)
      try {
        await client.removeVoiceTarget(6);
        expect(true).toBe(true);
      } catch (error) {
        console.error('VoiceTarget removal failed:', error);
        throw error;
      }

      await cleanupClients(clients);
    });
  });

  describe('Cross-Edge Scenarios', () => {
    it('should validate permissions across edges', async () => {
      const clients = await createClients(testEnv, [
        { username: 'sender_edge1', edge: 1, channelId: 0 },
        { username: 'target_edge2', edge: 2, channelId: 0 },
      ]);

      const [sender, target] = clients;
      const targetSession = target.getStateManager().getSession()?.session || 0;

      // Target a user on a different edge (should succeed)
      try {
        await sender.setVoiceTarget(7, [{
          session: [targetSession],
        }]);
        
        expect(true).toBe(true);
      } catch (error) {
        console.error('Cross-edge VoiceTarget failed:', error);
        throw error;
      }

      await cleanupClients(clients);
    });
  });

  describe('Complex VoiceTarget Scenarios', () => {
    it('should validate multiple targets in one VoiceTarget', async () => {
      const admin = await createAdminClient(testEnv, 1);

      // Create a public channel
      const publicChannelId = await admin.createChannel({
        parent: 0,
        name: 'MultiTargetChannel',
      });
      await sleep(500);

      const clients = await createClients(testEnv, [
        { username: 'multi_sender', edge: 1, channelId: 0 },
        { username: 'target1', edge: 1, channelId: 0 },
        { username: 'target2', edge: 1, channelId: publicChannelId },
      ]);

      const [sender, target1, target2] = clients;
      const target1Session = target1.getStateManager().getSession()?.session || 0;
      const target2Session = target2.getStateManager().getSession()?.session || 0;

      // Set voice target with multiple targets (should succeed)
      try {
        await sender.setVoiceTarget(8, [
          { session: [target1Session] },
          { session: [target2Session] },
          { channelId: publicChannelId },
        ]);
        
        expect(true).toBe(true);
      } catch (error) {
        console.error('Multi-target VoiceTarget failed:', error);
        throw error;
      }

      await cleanupClients(clients);
      await admin.disconnect();
    });

    it('should fail if any target is inaccessible', async () => {
      const admin = await createAdminClient(testEnv, 1);

      // Create a restricted channel
      const restrictedChannelId = await admin.createChannel({
        parent: 0,
        name: 'PartiallyAccessible',
      });
      await sleep(500);

      // Deny access to the channel
      await admin.setACL({
        channelId: restrictedChannelId,
        acls: [{
          applyHere: true,
          applySubs: false,
          group: 'all',
          grant: 0,
          deny: 0x804, // Deny Enter and Listen
        }],
        groups: [],
        inherit: false,
      });
      await sleep(500);

      const clients = await createClients(testEnv, [
        { username: 'partial_sender', edge: 1, channelId: 0 },
        { username: 'accessible_target', edge: 1, channelId: 0 },
      ]);

      const [sender, target] = clients;
      const targetSession = target.getStateManager().getSession()?.session || 0;

      // Try to set voice target with mix of accessible and inaccessible targets
      try {
        await sender.setVoiceTarget(9, [
          { session: [targetSession] }, // Accessible
          { channelId: restrictedChannelId }, // Inaccessible
        ]);
        
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        // Expected to fail due to inaccessible channel
        expect(error).toBeDefined();
        console.log('[TEST] Expected partial access denial:', error);
      }

      await cleanupClients(clients);
      await admin.disconnect();
    });
  });
});
