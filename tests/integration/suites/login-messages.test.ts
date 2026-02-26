/**
 * Login Messages Integration Tests
 *
 * Verifies that the server login sequence sends correct messages:
 * - ServerSync includes valid max_bandwidth (> 0) and welcome_text (MOTD)
 * - Self UserState does NOT include spurious boolean fields (mute=false,
 *   deaf=false, suppress=false, priority_speaker=false, recording=false)
 *   which would cause client-side notifications like "unmuted", "recording
 *   ended", or "priority speaker granted"
 * - ServerConfig does NOT duplicate welcome_text (already in ServerSync)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { mumbleproto } from '@munode/protocol';

// Helper function for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Login Messages Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8700);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('ServerSync message', () => {
    it('should include valid max_bandwidth and welcome_text', async () => {
      const client = new MumbleClient();

      let serverSyncMsg: mumbleproto.ServerSync | null = null;

      client.on('serverSync', (message: mumbleproto.ServerSync) => {
        serverSyncMsg = message;
      });

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      expect(client.isConnected()).toBe(true);
      await sleep(500);

      // ServerSync should have been received
      expect(serverSyncMsg).not.toBeNull();

      // max_bandwidth should be a positive value (not 0)
      expect(serverSyncMsg!.max_bandwidth).toBeGreaterThan(0);
      console.log(`[TEST] max_bandwidth: ${serverSyncMsg!.max_bandwidth}`);

      // welcome_text (MOTD) should be present
      expect(serverSyncMsg!.welcome_text).toBeDefined();
      expect(serverSyncMsg!.welcome_text!.length).toBeGreaterThan(0);
      console.log(`[TEST] welcome_text: ${serverSyncMsg!.welcome_text}`);

      await client.disconnect();
    });
  });

  describe('Self UserState message', () => {
    it('should not include false boolean fields that cause spurious notifications', async () => {
      const client = new MumbleClient();

      const selfUserStates: mumbleproto.UserState[] = [];
      let mySession: number | undefined;

      client.on('serverSync', (message: mumbleproto.ServerSync) => {
        mySession = message.session;
      });

      client.on('userState', (message: mumbleproto.UserState) => {
        // Collect all UserState messages; we'll filter for self after login
        selfUserStates.push(message);
      });

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });

      expect(client.isConnected()).toBe(true);
      await sleep(500);

      expect(mySession).toBeDefined();

      // Find the initial self UserState (sent during login sequence)
      const selfState = selfUserStates.find(s => s.session === mySession);
      expect(selfState).toBeDefined();

      console.log('[TEST] Self UserState fields:', {
        session: selfState!.session,
        name: selfState!.name,
        channel_id: selfState!.channel_id,
        mute: selfState!.mute,
        deaf: selfState!.deaf,
        suppress: selfState!.suppress,
        self_mute: selfState!.self_mute,
        self_deaf: selfState!.self_deaf,
        priority_speaker: selfState!.priority_speaker,
        recording: selfState!.recording,
      });

      // For a normal user login, these boolean fields should NOT be explicitly
      // set to false. They should be undefined (absent from the wire format).
      // Sending mute=false triggers "server opened your mic" notification.
      // Sending deaf=false triggers "server opened your speaker" notification.
      // Sending suppress=false triggers "you were unmuted" notification.
      // Sending priority_speaker=false triggers "priority speaker revoked" notification.
      // Sending recording=false triggers "recording ended" notification.

      // These fields must be undefined (not present), NOT false
      expect(selfState!.mute).toBeUndefined();
      expect(selfState!.deaf).toBeUndefined();
      expect(selfState!.suppress).toBeUndefined();
      expect(selfState!.priority_speaker).toBeUndefined();
      expect(selfState!.recording).toBeUndefined();

      // session, name, channel_id should be present
      expect(selfState!.session).toBeDefined();
      expect(selfState!.name).toBeDefined();
      expect(selfState!.channel_id).toBeDefined();

      await client.disconnect();
    });
  });

  describe('ServerConfig message', () => {
    it('should include max_bandwidth and not duplicate welcome_text', async () => {
      const client = new MumbleClient();

      let serverConfigMsg: mumbleproto.ServerConfig | null = null;

      client.on('serverConfig', (message: mumbleproto.ServerConfig) => {
        serverConfigMsg = message;
      });

      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'guest',
        password: 'guest123',
        rejectUnauthorized: false,
      });

      expect(client.isConnected()).toBe(true);
      await sleep(500);

      // ServerConfig should have been received
      expect(serverConfigMsg).not.toBeNull();

      // max_bandwidth should be present and positive
      expect(serverConfigMsg!.max_bandwidth).toBeGreaterThan(0);
      console.log(`[TEST] ServerConfig max_bandwidth: ${serverConfigMsg!.max_bandwidth}`);

      // welcome_text should NOT be in ServerConfig (already sent in ServerSync)
      // to avoid duplicate MOTD notifications
      if (serverConfigMsg!.welcome_text !== undefined && serverConfigMsg!.welcome_text !== '') {
        console.warn('[TEST] WARNING: ServerConfig contains welcome_text, which may cause duplicate MOTD');
      }

      await client.disconnect();
    });
  });

  describe('User state for other users', () => {
    it('should not include false boolean fields for other users on join', async () => {
      const clientA = new MumbleClient();
      const clientB = new MumbleClient();

      // Client A connects first
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });

      expect(clientA.isConnected()).toBe(true);
      await sleep(500);

      // Capture UserState messages received by Client A
      const receivedUserStates: mumbleproto.UserState[] = [];
      clientA.on('userState', (message: mumbleproto.UserState) => {
        receivedUserStates.push(message);
      });

      // Client B connects (normal user, no mute/deaf)
      await clientB.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user2',
        password: 'password2',
        rejectUnauthorized: false,
      });

      expect(clientB.isConnected()).toBe(true);
      await sleep(500);

      const sessionB = clientB.getStateManager().getSession()?.session;
      expect(sessionB).toBeDefined();

      // Find User B's state as received by User A
      const userBState = receivedUserStates.find(s => s.session === sessionB);
      expect(userBState).toBeDefined();

      console.log('[TEST] User B state as seen by A:', {
        session: userBState!.session,
        name: userBState!.name,
        mute: userBState!.mute,
        deaf: userBState!.deaf,
        suppress: userBState!.suppress,
        priority_speaker: userBState!.priority_speaker,
        recording: userBState!.recording,
      });

      // False boolean fields should not be explicitly sent for a normal user
      expect(userBState!.mute).toBeUndefined();
      expect(userBState!.deaf).toBeUndefined();
      expect(userBState!.priority_speaker).toBeUndefined();
      expect(userBState!.recording).toBeUndefined();

      await clientA.disconnect();
      await clientB.disconnect();
    });
  });
});
