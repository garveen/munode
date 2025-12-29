/**
 * Hub Restart Integration Tests
 * 
 * Test scenario: User synchronization after Hub restart
 * - Two clients A and B are connected to the same Edge
 * - Hub restarts
 * - A reconnects to Edge
 * - B stays connected (doesn't reconnect)
 * 
 * Expected results:
 * - A sees both itself and B
 * - B sees both itself and A (no duplicates)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { HubServer } from '../../../packages/hub-server/src/index.js';
import { HubConfigSchema } from '../../../packages/hub-server/src/config-schema.js';
import type { HubConfig } from '../../../packages/hub-server/src/config-schema.js';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../../..');

// Test port configuration
const TEST_BASE_PORT = 8095;

describe('Hub Restart User Sync Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(TEST_BASE_PORT);
    // setupTestEnvironment now waits for services to be ready
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
    // cleanup() now checks port availability
  });

  it('should sync users correctly after Hub restart', async () => {
    // Connect client A
    const clientA = new MumbleClient();
    await clientA.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(clientA.isConnected()).toBe(true);

    // Connect client B
    const clientB = new MumbleClient();
    await clientB.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user2',
      password: 'password2',
      rejectUnauthorized: false,
    });
    expect(clientB.isConnected()).toBe(true);

    // Wait for synchronization
    await sleep(500);

    // Verify both clients see each other before Hub restart
    let usersA = clientA.getUsers();
    let usersB = clientB.getUsers();
    
    expect(usersA.length).toBeGreaterThanOrEqual(2);
    expect(usersB.length).toBeGreaterThanOrEqual(2);
    
    console.log(`Before restart - Client A sees ${usersA.length} users:`, usersA.map(u => u.name));
    console.log(`Before restart - Client B sees ${usersB.length} users:`, usersB.map(u => u.name));

    // Store Hub server for restart
    const oldHubServer = testEnv.hubServer;

    // Stop Hub server
    console.log('Stopping Hub server...');
    if (oldHubServer) {
      await oldHubServer.stop();
    }

    // Wait for Hub to fully stop
    await sleep(1000);

    // Restart Hub with the same config
    console.log('Restarting Hub...');
    
    // Load and parse config
    const hubConfigSourcePath = join(PROJECT_ROOT, 'tests/config/hub-test.js');
    const hubConfigModule = await import(`file://${hubConfigSourcePath}?v=${Date.now()}`);
    const hubConfigInput = { ...(hubConfigModule.default || hubConfigModule) };
    
    // Override ports (auth config will use callback from hub-test.js)
    hubConfigInput.port = testEnv.hubPort;
    hubConfigInput.control_port = testEnv.hubPort + 1;
    hubConfigInput.web_api = hubConfigInput.web_api || { enabled: true, host: '127.0.0.1', cors: true };
    hubConfigInput.web_api.port = testEnv.hubPort + 2;
    // auth 配置保留 hub-test.js 中的 callback
    
    // Parse config to apply defaults and validate
    const hubConfig = HubConfigSchema.parse(hubConfigInput);
    
    const newHubServer = new HubServer(hubConfig);
    await newHubServer.start();
    testEnv.hubServer = newHubServer;
    
    // Wait for Hub to restart and Edge to reconnect
    console.log('Waiting for Hub to restart and Edge to reconnect...');
    await sleep(3000);

    // Client B should still be connected (it didn't disconnect)
    expect(clientB.isConnected()).toBe(true);

    // Client A might have been disconnected due to Hub restart, try to reconnect
    if (!clientA.isConnected()) {
      console.log('Client A disconnected, reconnecting...');
      await clientA.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: 'user1',
        password: 'password1',
        rejectUnauthorized: false,
      });
    }

    // Wait for synchronization after Hub restart
    await sleep(2000);

    // Get final user lists
    usersA = clientA.getUsers();
    usersB = clientB.getUsers();

    console.log(`After restart - Client A sees ${usersA.length} users:`, usersA.map(u => u.name));
    console.log(`After restart - Client B sees ${usersB.length} users:`, usersB.map(u => u.name));

    // Verify both clients still see each other after Hub restart
    // A should see at least 2 users (itself and B)
    expect(usersA.length).toBeGreaterThanOrEqual(2);
    
    // B should see at least 2 users (itself and A), and NOT see duplicates
    expect(usersB.length).toBeGreaterThanOrEqual(2);
    
    // Check for duplicate users (the bug was B seeing two As)
    const usernamesB = usersB.map(u => u.name);
    const uniqueUsernamesB = [...new Set(usernamesB)];
    expect(usernamesB.length).toBe(uniqueUsernamesB.length);

    // Verify A can see B
    expect(usersA.some(u => u.name === 'user2')).toBe(true);
    
    // Verify B can see A (without duplicates)
    const user1CountInB = usersB.filter(u => u.name === 'user1').length;
    expect(user1CountInB).toBe(1);

    // Cleanup
    await clientA.disconnect();
    await clientB.disconnect();
  }, 60000); // 60 second timeout for this test
});
