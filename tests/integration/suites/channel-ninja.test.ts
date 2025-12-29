/**
 * Channel Ninja Feature Integration Tests
 *
 * Tests for the Channel Ninja functionality based on the requirements:
 * 
 * Prerequisites for a channel to be hidden from a user:
 * - Hub server has ninja configuration enabled
 * - The channel is specified in the ninjaChannels list
 * - The user cannot enter AND cannot listen to the channel
 * - The user cannot enter AND cannot listen to any linked channels (including transitive links)
 * 
 * Functionality details:
 * - When ninja is disabled: All users see all channels, behavior same as official server
 * - When ninja is enabled:
 *   - Hub specifies channel IDs that are ninja channels via ninjaChannels config
 *   - Users with permission see all activity normally
 *   - Users without permission see privileged users as offline when they enter hidden channels
 *   - Users without permission cannot see any linked channels
 *   - Users moved into hidden channel by admin can see the channel until they leave
 *   - Users without permission reconnecting in hidden channel are moved to default
 *   - Users with permission reconnecting in hidden channel stay there
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { PermissionFlag } from '../fixtures';

// Helper function for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Use channel ID 1 (General) as the ninja channel for testing
const NINJA_CHANNEL_ID = 1;

describe('Channel Ninja Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Create test environment with ninja enabled and channel 1 as ninja channel
    testEnv = await setupTestEnvironment(8100, {
      reuse: false, // 禁用复用以确保配置生效
      silent: false,
      hubConfig: {
        channel_ninja: true, // Enable Channel Ninja functionality
        ninja_channels: [NINJA_CHANNEL_ID], // Channel 1 (General) is the ninja channel
        log_level: 'info' as const,
      },
    });
    
    // Set up ACL on the ninja channel to allow only "ninja" group users
    const setupAdmin = new MumbleClient();
    try {
      await setupAdmin.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      
      await sleep(1000);
      
      // Set ACL: first deny all users, then allow ninja group
      // Order matters: later rules override earlier ones
      await setupAdmin.saveACL(NINJA_CHANNEL_ID, [
        {
          apply_here: true,
          apply_subs: true,
          inherited: false,
          group: 'all',
          allow: 0,
          deny: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Listen,
        },
        {
          apply_here: true,
          apply_subs: true,
          inherited: false,
          group: 'ninja',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak | PermissionFlag.Listen,
          deny: 0,
        },
      ]);
      
      await sleep(500);
    } finally {
      await setupAdmin.disconnect();
    }
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  describe('Basic Ninja Functionality', () => {
    it('should hide users in ninja channels from unprivileged users', async () => {
      const ninjaUser = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Ninja group user connects (has permission to enter ninja channel)
        await ninjaUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'ninja_user1',
          password: 'ninja_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
        expect(ninjaSession).toBeDefined();

        // Normal user connects (no permission to ninja channel)
        await normalUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Initially, normal user should see ninja user (both in root channel)
        let users = normalUser.getUsers();
        let ninjaInList = users.some((u: any) => u.session === ninjaSession);
        expect(ninjaInList).toBe(true);

        // Track UserRemove events
        let sawNinjaRemove = false;
        normalUser.on('userRemove', (remove: any) => {
          if (remove.session === ninjaSession) {
            sawNinjaRemove = true;
          }
        });

        // Ninja user moves to ninja channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          channel_id: NINJA_CHANNEL_ID,
        });

        // Wait for the ninja logic to process
        await sleep(2000);

        // Normal user should receive UserRemove for ninja user (appears offline)
        expect(sawNinjaRemove).toBe(true);
      } finally {
        await ninjaUser.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);

    it('should show users again when they leave ninja channel', async () => {
      const ninjaUser = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Ninja user connects and moves to ninja channel first
        await ninjaUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'ninja_user2',
          password: 'ninja_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
        expect(ninjaSession).toBeDefined();

        // Ninja user moves to ninja channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          channel_id: NINJA_CHANNEL_ID,
        });
        await sleep(500);

        // Normal user connects (ninja user should be invisible)
        await normalUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Normal user should NOT see ninja user initially
        let users = normalUser.getUsers();
        let ninjaInList = users.some((u: any) => u.session === ninjaSession);
        expect(ninjaInList).toBe(false);

        // Track UserState events to see ninja user "appear"
        let sawNinjaAppear = false;
        normalUser.on('userState', (state: any) => {
          if (state.session === ninjaSession && state.channel_id === 0) {
            sawNinjaAppear = true;
          }
        });

        // Ninja user moves back to root channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          channel_id: 0,
        });

        // Wait for update
        await sleep(2000);

        // Normal user should now see ninja user
        expect(sawNinjaAppear).toBe(true);
      } finally {
        await ninjaUser.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);

    it('should not broadcast state changes of hidden users to unprivileged users', async () => {
      const ninjaUser = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Ninja user connects and moves to ninja channel
        await ninjaUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'ninja_user1',
          password: 'ninja_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
        expect(ninjaSession).toBeDefined();

        // Ninja user moves to ninja channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          channel_id: NINJA_CHANNEL_ID,
        });
        await sleep(500);

        // Normal user connects
        await normalUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_state',
          password: 'user_password',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Track all state changes for ninja user
        let sawNinjaStateChange = false;
        normalUser.on('userState', (state: any) => {
          if (state.session === ninjaSession) {
            sawNinjaStateChange = true;
          }
        });

        // Ninja user changes mute state while in ninja channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          self_mute: true,
        });

        // Wait for any potential state update
        await sleep(2000);

        // Normal user should NOT see any state changes from ninja user
        expect(sawNinjaStateChange).toBe(false);
      } finally {
        await ninjaUser.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);
  });

  describe('Cross-Edge Ninja Functionality', () => {
    it('should filter visibility across multiple Edge servers', async () => {
      const ninjaUser = new MumbleClient();
      const userEdge1 = new MumbleClient();
      const userEdge2 = new MumbleClient();

      try {
        // Ninja group user connects to Edge 1 (has permission to enter ninja channel)
        await ninjaUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'ninja_cross',
          password: 'ninja_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
        expect(ninjaSession).toBeDefined();

        // Normal user on Edge 1
        await userEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user_cross1',
          password: 'user_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        // Normal user on Edge 2
        await userEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'user_cross2',
          password: 'user_password',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Track UserRemove events on both edges
        let edge1SawRemove = false;
        let edge2SawRemove = false;

        userEdge1.on('userRemove', (remove: any) => {
          if (remove.session === ninjaSession) {
            edge1SawRemove = true;
          }
        });

        userEdge2.on('userRemove', (remove: any) => {
          if (remove.session === ninjaSession) {
            edge2SawRemove = true;
          }
        });

        // Ninja user moves to ninja channel
        ninjaUser.sendUserState({
          session: ninjaSession,
          channel_id: NINJA_CHANNEL_ID,
        });

        // Wait for cross-edge propagation
        await sleep(3000);

        // Both users on different edges should see ninja user disappear
        expect(edge1SawRemove).toBe(true);
        expect(edge2SawRemove).toBe(true);
      } finally {
        await ninjaUser.disconnect();
        await userEdge1.disconnect();
        await userEdge2.disconnect();
      }
    }, 45000);
  });
});

describe('Channel Ninja Disabled Tests', () => {
  let testEnv: TestEnvironment;
  let restrictedChannelId: number;

  beforeAll(async () => {
    // Create test environment with ninja DISABLED
    testEnv = await setupTestEnvironment(8200, {
      reuse: false, // 禁用复用以确保配置生效
      hubConfig: {
        channel_ninja: false, // Disable Channel Ninja
      },
    });

    // Create a restricted channel for testing (same as ninja channel ID for consistency)
    restrictedChannelId = NINJA_CHANNEL_ID;
    
    const setupAdmin = new MumbleClient();
    try {
      await setupAdmin.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'admin',
        password: 'admin123',
        rejectUnauthorized: false,
      });
      
      await sleep(1000);
      
      // Set ACL: first deny all users, then allow ninja group
      // Even though ninja mode is disabled, we still set up ACL for testing
      await setupAdmin.saveACL(restrictedChannelId, [
        {
          apply_here: true,
          apply_subs: true,
          inherited: false,
          group: 'all',
          allow: 0,
          deny: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Listen,
        },
        {
          apply_here: true,
          apply_subs: true,
          inherited: false,
          group: 'ninja',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak | PermissionFlag.Listen,
          deny: 0,
        },
      ]);
      
      await sleep(500);
    } finally {
      await setupAdmin.disconnect();
    }
  }, 120000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should NOT hide users when ninja is disabled', async () => {
    const ninjaUser = new MumbleClient();
    const normalUser = new MumbleClient();

    try {
      // Ninja group user connects (has permission to enter the channel)
      await ninjaUser.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'ninja_user1',
        password: 'ninja_password',
        rejectUnauthorized: false,
      });
      await sleep(500);

      const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
      expect(ninjaSession).toBeDefined();

      // Normal user connects
      await normalUser.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(1000);

      // Track events
      let sawNinjaMove = false;
      let sawNinjaRemove = false;

      normalUser.on('userState', (state: any) => {
        if (state.session === ninjaSession && state.channel_id === restrictedChannelId) {
          sawNinjaMove = true;
        }
      });

      normalUser.on('userRemove', (remove: any) => {
        if (remove.session === ninjaSession) {
          sawNinjaRemove = true;
        }
      });

      // Ninja user moves to restricted channel
      ninjaUser.sendUserState({
        session: ninjaSession,
        channel_id: restrictedChannelId,
      });

      // Wait for state update
      await sleep(2000);

      // With ninja disabled, normal user should see ninja user MOVE (not disappear)
      expect(sawNinjaMove).toBe(true);
      expect(sawNinjaRemove).toBe(false);
    } finally {
      await ninjaUser.disconnect();
      await normalUser.disconnect();
    }
  }, 30000);
});

