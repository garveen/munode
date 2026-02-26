/**
 * Client Disconnect Cleanup Integration Tests (Rust Bug Fix)
 *
 * Verifies that when a client disconnects (cleanly or abruptly), their
 * session is properly removed from the hub's active session list so that
 * reconnecting clients do not see "zombie" sessions from the previous
 * connection.
 *
 * Issue: In the Rust edge server, any IO error (TCP RST / abrupt disconnect)
 * during the client connection loop caused an early return via the `?`
 * operator, bypassing the cleanup block that removes the client from the
 * hub's session_manager.  This left stale sessions in the hub, making a
 * reconnecting user appear twice to other clients.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, USE_RUST } from '../setup.js';
import { MumbleClient } from '../../../packages/client/src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Client Disconnect Cleanup Tests', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment(8800);
  }, 60000);

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('should remove session from hub after clean disconnect, no zombie on reconnect', async () => {
    // Step 1: Connect user A
    const clientA1 = new MumbleClient();
    await clientA1.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(clientA1.isConnected()).toBe(true);

    const sessionA1 = clientA1.getStateManager().getSession()?.session;
    expect(sessionA1).toBeDefined();
    console.log(`[TEST] user1 first login: session=${sessionA1}`);

    // Wait for session to be fully registered
    await sleep(500);

    // Step 2: Clean disconnect (sends FIN)
    await clientA1.disconnect();
    await sleep(500); // let hub process the user-left notification

    // Step 3: Reconnect user A
    const clientA2 = new MumbleClient();
    await clientA2.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(clientA2.isConnected()).toBe(true);

    const sessionA2 = clientA2.getStateManager().getSession()?.session;
    expect(sessionA2).toBeDefined();
    console.log(`[TEST] user1 second login: session=${sessionA2}`);

    // Sessions should be different (new session ID allocated)
    expect(sessionA2).not.toBe(sessionA1);

    // Wait for state to stabilize
    await sleep(300);

    // Step 4: Connect observer client B
    const clientB = new MumbleClient();
    await clientB.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user2',
      password: 'password2',
      rejectUnauthorized: false,
    });
    expect(clientB.isConnected()).toBe(true);

    await sleep(300);

    // Step 5: Verify user B sees exactly one instance of user1 (no zombie)
    const usersSeenByB = clientB.getUsers();
    const user1Instances = usersSeenByB.filter(u => u.name === 'user1');
    console.log(`[TEST] user2 sees ${user1Instances.length} instance(s) of user1`);
    console.log(`[TEST] All users seen by user2: ${usersSeenByB.map(u => `${u.name}(${u.session})`).join(', ')}`);

    expect(user1Instances).toHaveLength(1);
    // The visible instance should be the new session
    expect(user1Instances[0].session).toBe(sessionA2);

    await clientA2.disconnect();
    await clientB.disconnect();
  });

  it('should remove session from hub after abrupt disconnect (TCP RST), no zombie on reconnect', async () => {
    // Step 1: Connect user A
    const clientA1 = new MumbleClient();
    await clientA1.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user_state',
      password: 'user_password',
      rejectUnauthorized: false,
    });
    expect(clientA1.isConnected()).toBe(true);

    const sessionA1 = clientA1.getStateManager().getSession()?.session;
    expect(sessionA1).toBeDefined();
    console.log(`[TEST] user_state first login: session=${sessionA1}`);

    // Wait for session to be fully registered
    await sleep(500);

    // Step 2: Abrupt disconnect — destroy the socket (sends TCP RST)
    // Use the destroySocket() method on ConnectionManager to simulate RST
    clientA1.getConnectionManager().destroySocket();
    console.log('[TEST] TCP socket destroyed (RST sent)');

    // Wait longer for hub to process the disconnect / cleanup
    await sleep(1000);

    // Step 3: Reconnect user A
    const clientA2 = new MumbleClient();
    await clientA2.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user_state',
      password: 'user_password',
      rejectUnauthorized: false,
    });
    expect(clientA2.isConnected()).toBe(true);

    const sessionA2 = clientA2.getStateManager().getSession()?.session;
    expect(sessionA2).toBeDefined();
    console.log(`[TEST] user_state second login: session=${sessionA2}`);

    // Sessions should be different (new session ID allocated)
    expect(sessionA2).not.toBe(sessionA1);

    // Wait for state to stabilize
    await sleep(300);

    // Step 4: Connect observer client
    const clientB = new MumbleClient();
    await clientB.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'user_edge1',
      password: 'user_password',
      rejectUnauthorized: false,
    });
    expect(clientB.isConnected()).toBe(true);

    await sleep(300);

    // Step 5: Verify observer sees exactly one instance of user_state (no zombie)
    const usersSeenByB = clientB.getUsers();
    const userStateInstances = usersSeenByB.filter(u => u.name === 'user_state');
    console.log(`[TEST] observer sees ${userStateInstances.length} instance(s) of user_state`);
    console.log(`[TEST] All users seen by observer: ${usersSeenByB.map(u => `${u.name}(${u.session})`).join(', ')}`);

    expect(userStateInstances).toHaveLength(1);
    // The visible instance should be the new session
    expect(userStateInstances[0].session).toBe(sessionA2);

    await clientA2.disconnect();
    await clientB.disconnect();
  });

  it('should not show disconnected users to newly connecting clients', async () => {
    // Connect and immediately disconnect multiple users
    const users = [
      { username: 'user1', password: 'password1' },
      { username: 'user2', password: 'password2' },
    ];

    for (const user of users) {
      const client = new MumbleClient();
      await client.connect({
        host: 'localhost',
        port: testEnv.edgePort,
        username: user.username,
        password: user.password,
        rejectUnauthorized: false,
      });
      // Abruptly destroy socket (TCP RST)
      client.getConnectionManager().destroySocket();
      await sleep(200);
    }

    // Wait for hub to process all disconnects
    await sleep(1000);

    // Connect a fresh observer
    const observer = new MumbleClient();
    await observer.connect({
      host: 'localhost',
      port: testEnv.edgePort,
      username: 'sender_edge1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    expect(observer.isConnected()).toBe(true);

    await sleep(300);

    // The observer should NOT see user1 or user2 since they've all disconnected
    const visibleUsers = observer.getUsers();
    console.log(`[TEST] Observer sees: ${visibleUsers.map(u => u.name).join(', ')}`);

    const disconnectedStillVisible = visibleUsers.filter(
      u => users.some(usr => usr.username === u.name)
    );

    if (disconnectedStillVisible.length > 0) {
      console.log(`[TEST] Zombie users still visible: ${disconnectedStillVisible.map(u => u.name).join(', ')}`);
    }

    expect(disconnectedStillVisible).toHaveLength(0);

    await observer.disconnect();
  });
});
