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
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/dist/index.js';
import { PermissionFlag } from '../fixtures';

// Use channel ID 1 (General) as the ninja channel for testing
const NINJA_CHANNEL_ID = 1;

describe('Channel Ninja Integration Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Create test environment with ninja enabled and channel 1 as ninja channel
    testEnv = await setupTestEnvironment(8100, {
      hubConfig: {
        channelNinja: true, // Enable Channel Ninja functionality
        ninjaChannels: [NINJA_CHANNEL_ID], // Channel 1 (General) is the ninja channel
      },
    });
    
    // Set up ACL on the ninja channel to deny access to non-admin users
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
      
      // Set ACL to deny Enter and Listen for non-admin users on the ninja channel
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
          group: 'admin',
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
      const admin = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Admin connects
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_state',
          password: 'admin_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const adminSession = admin.getStateManager().getSession()?.session;
        expect(adminSession).toBeDefined();

        // Normal user connects
        await normalUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user1',
          password: 'password1',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Initially, normal user should see admin
        let users = normalUser.getUsers();
        let adminInList = users.some((u: any) => u.session === adminSession);
        expect(adminInList).toBe(true);

        // Track UserRemove events
        let sawAdminRemove = false;
        normalUser.on('userRemove', (remove: any) => {
          if (remove.session === adminSession) {
            sawAdminRemove = true;
          }
        });

        // Admin moves to ninja channel
        admin.sendUserState({
          session: adminSession,
          channel_id: NINJA_CHANNEL_ID,
        });

        // Wait for the ninja logic to process
        await sleep(2000);

        // Normal user should receive UserRemove for admin
        expect(sawAdminRemove).toBe(true);
      } finally {
        await admin.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);

    it('should show users again when they leave ninja channel', async () => {
      const admin = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Admin connects and moves to ninja channel first
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_multi',
          password: 'admin_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const adminSession = admin.getStateManager().getSession()?.session;
        expect(adminSession).toBeDefined();

        // Admin moves to ninja channel
        admin.sendUserState({
          session: adminSession,
          channel_id: NINJA_CHANNEL_ID,
        });
        await sleep(500);

        // Normal user connects (admin should be invisible)
        await normalUser.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'user2',
          password: 'password2',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Normal user should NOT see admin initially
        let users = normalUser.getUsers();
        let adminInList = users.some((u: any) => u.session === adminSession);
        expect(adminInList).toBe(false);

        // Track UserState events to see admin "appear"
        let sawAdminAppear = false;
        normalUser.on('userState', (state: any) => {
          if (state.session === adminSession && state.channel_id === 0) {
            sawAdminAppear = true;
          }
        });

        // Admin moves back to root channel
        admin.sendUserState({
          session: adminSession,
          channel_id: 0,
        });

        // Wait for update
        await sleep(2000);

        // Normal user should now see admin
        expect(sawAdminAppear).toBe(true);
      } finally {
        await admin.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);

    it('should not broadcast state changes of hidden users to unprivileged users', async () => {
      const admin = new MumbleClient();
      const normalUser = new MumbleClient();

      try {
        // Admin connects and moves to ninja channel
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'admin_no_ninja',
          password: 'admin_password',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const adminSession = admin.getStateManager().getSession()?.session;
        expect(adminSession).toBeDefined();

        // Admin moves to ninja channel
        admin.sendUserState({
          session: adminSession,
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

        // Track all state changes for admin
        let sawAdminStateChange = false;
        normalUser.on('userState', (state: any) => {
          if (state.session === adminSession) {
            sawAdminStateChange = true;
          }
        });

        // Admin changes mute state while in ninja channel
        admin.sendUserState({
          session: adminSession,
          self_mute: true,
        });

        // Wait for any potential state update
        await sleep(2000);

        // Normal user should NOT see any state changes from admin
        expect(sawAdminStateChange).toBe(false);
      } finally {
        await admin.disconnect();
        await normalUser.disconnect();
      }
    }, 30000);
  });

  describe('Cross-Edge Ninja Functionality', () => {
    it('should filter visibility across multiple Edge servers', async () => {
      const admin = new MumbleClient();
      const userEdge1 = new MumbleClient();
      const userEdge2 = new MumbleClient();

      try {
        // Admin connects to Edge 1
        await admin.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'sender1',
          password: 'password1',
          rejectUnauthorized: false,
        });
        await sleep(500);

        const adminSession = admin.getStateManager().getSession()?.session;
        expect(adminSession).toBeDefined();

        // User on Edge 1
        await userEdge1.connect({
          host: 'localhost',
          port: testEnv.edgePort,
          username: 'receiver1',
          password: 'password1',
          rejectUnauthorized: false,
        });
        await sleep(500);

        // User on Edge 2
        await userEdge2.connect({
          host: 'localhost',
          port: testEnv.edgePort2,
          username: 'receiver2',
          password: 'password2',
          rejectUnauthorized: false,
        });
        await sleep(1000);

        // Track UserRemove events on both edges
        let edge1SawRemove = false;
        let edge2SawRemove = false;

        userEdge1.on('userRemove', (remove: any) => {
          if (remove.session === adminSession) {
            edge1SawRemove = true;
          }
        });

        userEdge2.on('userRemove', (remove: any) => {
          if (remove.session === adminSession) {
            edge2SawRemove = true;
          }
        });

        // Admin moves to ninja channel
        admin.sendUserState({
          session: adminSession,
          channel_id: NINJA_CHANNEL_ID,
        });

        // Wait for cross-edge propagation
        await sleep(3000);

        // Both users on different edges should see admin disappear
        expect(edge1SawRemove).toBe(true);
        expect(edge2SawRemove).toBe(true);
      } finally {
        await admin.disconnect();
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
      hubConfig: {
        channelNinja: false, // Disable Channel Ninja
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
      
      // Set ACL to deny Enter for non-admin (but this shouldn't hide users since ninja is off)
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
          group: 'admin',
          allow: PermissionFlag.Enter | PermissionFlag.Traverse | PermissionFlag.Speak,
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
    const admin = new MumbleClient();
    const normalUser = new MumbleClient();

    try {
      // Admin connects
      await admin.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'sender2',
        password: 'password2',
        rejectUnauthorized: false,
      });
      await sleep(500);

      const adminSession = admin.getStateManager().getSession()?.session;
      expect(adminSession).toBeDefined();

      // Normal user connects
      await normalUser.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'receiver1_e1',
        password: 'password1',
        rejectUnauthorized: false,
      });
      await sleep(1000);

      // Track events
      let sawAdminMove = false;
      let sawAdminRemove = false;

      normalUser.on('userState', (state: any) => {
        if (state.session === adminSession && state.channel_id === restrictedChannelId) {
          sawAdminMove = true;
        }
      });

      normalUser.on('userRemove', (remove: any) => {
        if (remove.session === adminSession) {
          sawAdminRemove = true;
        }
      });

      // Admin moves to restricted channel
      admin.sendUserState({
        session: adminSession,
        channel_id: restrictedChannelId,
      });

      // Wait for state update
      await sleep(2000);

      // With ninja disabled, normal user should see admin MOVE (not disappear)
      expect(sawAdminMove).toBe(true);
      expect(sawAdminRemove).toBe(false);
    } finally {
      await admin.disconnect();
      await normalUser.disconnect();
    }
  }, 30000);
});

