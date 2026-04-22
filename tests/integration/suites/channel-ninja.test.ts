/**
 * Channel Ninja Feature Integration Tests (Rust)
 *
 * Verifies the following behaviors when channel_ninja is enabled and
 * channel 1 (General) is in ninja_channels:
 *
 *  1. On initial login: users without Enter/Listen on the ninja channel do NOT
 *     receive UserState for users sitting in that channel.
 *  2. When a user moves INTO the ninja channel: unprivileged observers receive
 *     UserRemove (the user "disappears").
 *  3. When a user moves OUT of the ninja channel: unprivileged observers
 *     receive a full UserState (the user "reappears").
 *  4. State changes (self_mute) while inside the ninja channel are NOT
 *     forwarded to unprivileged observers.
 *  5. Privileged users DO see users in the ninja channel.
 *  6. When ninja is DISABLED the normal move/visibility rules apply.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnvironment, setupTestEnvironment, sleep } from '../setup';
import { MumbleClient } from '../../../packages/client/src/index.js';
import { PermissionFlag } from '../fixtures';

// Channel 1 (General) is used as the ninja channel
const NINJA_CHANNEL_ID = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function connectUser(port: number, username: string, password: string): Promise<MumbleClient> {
  const client = new MumbleClient();
  await client.connect({
    host: 'localhost',
    port,
    username,
    password,
    rejectUnauthorized: false,
  });
  return client;
}

async function disconnectAll(...clients: MumbleClient[]): Promise<void> {
  for (const c of clients) {
    try { await c.disconnect(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Ninja ENABLED
// ─────────────────────────────────────────────────────────────────────────────

describe('Channel Ninja – enabled (Rust)', () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    // Isolated environment: channel 1 is a ninja channel.
    // ninja_user1 / ninja_user2 belong to the "ninja" group (defined in test-users.ts).
    // user1 / user2 are plain users with no special groups.
    //
    // ACL on channel 1: deny Enter+Listen to "all", allow Enter+Listen+Speak to "ninja".
    env = await setupTestEnvironment(8504, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        channel_ninja: {
          enabled: true,
          ninja_channels: [NINJA_CHANNEL_ID],
        },
      },
    });

    // Configure ACL so that only the "ninja" group can enter/listen to channel 1
    const admin = await connectUser(env.edgePort, 'admin', 'admin123');
    await sleep(800);
    await admin.saveACL(NINJA_CHANNEL_ID, [
      {
        apply_here: true,
        apply_subs: true,
        inherited: false,
        group: 'all',
        allow: 0,
        deny: PermissionFlag.Enter | PermissionFlag.Listen,
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
    await admin.disconnect();
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  }, 30000);

  // ── Test 1 ──────────────────────────────────────────────────────────────────
  it('initial sync: unprivileged user does NOT see users in the ninja channel', async () => {
    // ninja_user1 connects and moves to channel 1
    const ninjaUser = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    ninjaUser.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(500);

    const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
    expect(ninjaSession).toBeDefined();

    // user1 (no ninja group) connects — should NOT receive ninja_user1 in sync
    const seenSessions: number[] = [];
    const normalUser = new MumbleClient();
    normalUser.on('userState', (state: any) => {
      const mySession = normalUser.getStateManager().getSession()?.session;
      if (state.session !== undefined && state.session !== mySession) {
        seenSessions.push(state.session);
      }
    });
    await normalUser.connect({
      host: 'localhost',
      port: env.edgePort,
      username: 'user1',
      password: 'password1',
      rejectUnauthorized: false,
    });
    await sleep(700);

    await disconnectAll(ninjaUser, normalUser);

    expect(seenSessions).not.toContain(ninjaSession);
  }, 25000);

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  it('move INTO ninja channel: unprivileged observer receives UserRemove', async () => {
    // Connect ninja_user1 and explicitly move to root (channel 0) to ensure a
    // known starting state regardless of server-persisted channel history.
    const ninjaUser = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    ninjaUser.sendUserState({ channel_id: 0 });
    await sleep(500);
    const normalUser = await connectUser(env.edgePort, 'user1', 'password1');
    await sleep(700);

    const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
    expect(ninjaSession).toBeDefined();

    // Verify normal user can see ninja_user1 while both are in root
    const visibleBefore = normalUser.getUsers().some((u: any) => u.session === ninjaSession);
    expect(visibleBefore).toBe(true);

    // Watch for UserRemove
    let gotRemove = false;
    normalUser.on('userRemove', (msg: any) => {
      if (msg.session === ninjaSession) gotRemove = true;
    });

    // ninja_user1 moves to ninja channel
    ninjaUser.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(1500);

    await disconnectAll(ninjaUser, normalUser);

    expect(gotRemove).toBe(true);
  }, 25000);

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  it('move OUT of ninja channel: unprivileged observer receives UserState (reappears)', async () => {
    // ninja_user1 starts in ninja channel BEFORE normal user connects
    const ninjaUser = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    ninjaUser.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(500);

    const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
    expect(ninjaSession).toBeDefined();

    // normal user connects — ninja_user1 should be invisible
    const normalUser = await connectUser(env.edgePort, 'user1', 'password1');
    await sleep(700);

    const visibleAtLogin = normalUser.getUsers().some((u: any) => u.session === ninjaSession);
    expect(visibleAtLogin).toBe(false);

    // Watch for the "reappear" UserState (channel_id = 0 = root)
    let gotAppear = false;
    normalUser.on('userState', (state: any) => {
      if (state.session === ninjaSession && state.channel_id === 0) {
        gotAppear = true;
      }
    });

    // ninja_user1 moves back to root (channel 0)
    ninjaUser.sendUserState({ channel_id: 0 });
    await sleep(1500);

    await disconnectAll(ninjaUser, normalUser);

    expect(gotAppear).toBe(true);
  }, 25000);

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  it('state change in ninja channel: NOT forwarded to unprivileged observer', async () => {
    // ninja_user1 starts in ninja channel
    const ninjaUser = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    ninjaUser.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(500);

    const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
    expect(ninjaSession).toBeDefined();

    const normalUser = await connectUser(env.edgePort, 'user1', 'password1');
    await sleep(700);

    let gotStateChange = false;
    normalUser.on('userState', (state: any) => {
      if (state.session === ninjaSession) gotStateChange = true;
    });

    // ninja_user1 mutes itself — normal user should NOT receive this
    ninjaUser.sendUserState({ self_mute: true });
    await sleep(1500);

    await disconnectAll(ninjaUser, normalUser);

    expect(gotStateChange).toBe(false);
  }, 25000);

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  it('privileged user DOES see users in ninja channel on initial sync', async () => {
    // ninja_user2 also belongs to the ninja group
    const ninjaUser1 = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    ninjaUser1.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(500);

    const ninjaSession1 = ninjaUser1.getStateManager().getSession()?.session;
    expect(ninjaSession1).toBeDefined();

    // ninja_user2 connects — should receive ninja_user1 in the initial sync
    const seenSessions: number[] = [];
    const ninjaUser2 = new MumbleClient();
    ninjaUser2.on('userState', (state: any) => {
      const mySession = ninjaUser2.getStateManager().getSession()?.session;
      if (state.session !== undefined && state.session !== mySession) {
        seenSessions.push(state.session);
      }
    });
    await ninjaUser2.connect({
      host: 'localhost',
      port: env.edgePort,
      username: 'ninja_user2',
      password: 'ninja_password',
      rejectUnauthorized: false,
    });
    await sleep(700);

    await disconnectAll(ninjaUser1, ninjaUser2);

    expect(seenSessions).toContain(ninjaSession1);
  }, 25000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Ninja DISABLED
// ─────────────────────────────────────────────────────────────────────────────

describe('Channel Ninja – disabled (Rust)', () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnvironment(8514, {
      startHub: true,
      startEdge: true,
      startEdge2: false,
      startAuth: true,
      silent: true,
      isolated: true,
      rustHubExtraConfig: {
        channel_ninja: {
          enabled: false,
          ninja_channels: [NINJA_CHANNEL_ID],
        },
      },
    });

    // Same ACL — but with ninja disabled it should have no effect on visibility
    const admin = await connectUser(env.edgePort, 'admin', 'admin123');
    await sleep(800);
    await admin.saveACL(NINJA_CHANNEL_ID, [
      {
        apply_here: true,
        apply_subs: true,
        inherited: false,
        group: 'all',
        allow: 0,
        deny: PermissionFlag.Enter | PermissionFlag.Listen,
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
    await admin.disconnect();
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  }, 30000);

  it('ninja disabled: move into restricted channel broadcasts UserState (not UserRemove)', async () => {
    const ninjaUser = await connectUser(env.edgePort, 'ninja_user1', 'ninja_password');
    await sleep(300);
    const normalUser = await connectUser(env.edgePort, 'user1', 'password1');
    await sleep(700);

    const ninjaSession = ninjaUser.getStateManager().getSession()?.session;
    expect(ninjaSession).toBeDefined();

    let gotMove = false;
    let gotRemove = false;

    normalUser.on('userState', (state: any) => {
      if (state.session === ninjaSession && state.channel_id === NINJA_CHANNEL_ID) {
        gotMove = true;
      }
    });
    normalUser.on('userRemove', (msg: any) => {
      if (msg.session === ninjaSession) gotRemove = true;
    });

    ninjaUser.sendUserState({ channel_id: NINJA_CHANNEL_ID });
    await sleep(1500);

    await disconnectAll(ninjaUser, normalUser);

    expect(gotMove).toBe(true);
    expect(gotRemove).toBe(false);
  }, 25000);
});
