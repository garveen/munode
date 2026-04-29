/**
 * StateManager — thin adapter around `@munode/client-core`'s state engine.
 *
 * The engine itself lives in `packages/client-core` and is platform-neutral.
 * This file forwards its callbacks into the host `MumbleClient`'s
 * `EventEmitter`-style API for backward compatibility.
 */

import { StateManager as CoreStateManager } from '@munode/client-core';
import type { mumbleproto } from '@munode/protocol';
import type { MumbleClient } from './mumble-client.js';
import type { Channel, ServerInfo, SessionState, User } from '../types/client-types.js';

export class StateManager {
  private client: MumbleClient;
  private core: CoreStateManager;

  constructor(client: MumbleClient) {
    this.client = client;
    this.core = new CoreStateManager({
      onServerSync: (m) => this.client.emit('serverSync', m),
      onServerConfig: (m) => this.client.emit('serverConfig', m),
      onChannelState: (m) => this.client.emit('channelState', m),
      onChannelRemove: (m) => this.client.emit('channelRemove', m),
      onUserState: (m) => this.client.emit('userState', m),
      onUserRemove: (m) => this.client.emit('userRemove', m),
      onPermissionDenied: (m) => this.client.emit('permissionDenied', m),
      onChannelDenied: (m) => this.client.emit('channelDenied', m),
      onKicked: (m) => {
        this.client.emit('kicked', m);
        this.client.disconnect();
      },
    });
  }

  handleServerSync(message: mumbleproto.ServerSync): void {
    this.core.handleServerSync(message);
  }
  handleServerConfig(message: mumbleproto.ServerConfig): void {
    this.core.handleServerConfig(message);
  }
  handleChannelState(message: mumbleproto.ChannelState): void {
    this.core.handleChannelState(message);
  }
  handleChannelRemove(message: mumbleproto.ChannelRemove): void {
    this.core.handleChannelRemove(message);
  }
  handleUserState(message: mumbleproto.UserState): void {
    this.core.handleUserState(message);
  }
  handleUserRemove(message: mumbleproto.UserRemove): void {
    this.core.handleUserRemove(message);
  }
  handlePermissionDenied(message: mumbleproto.PermissionDenied): void {
    this.core.handlePermissionDenied(message);
  }

  getChannel(channelId: number): Channel | null {
    return this.core.getChannel(channelId) as Channel | null;
  }
  getChannels(): Channel[] {
    return this.core.getChannels() as Channel[];
  }
  getUser(session: number): User | null {
    return this.core.getUser(session) as User | null;
  }
  getUsers(): User[] {
    return this.core.getUsers() as User[];
  }
  getUsersInChannel(channelId: number): User[] {
    return this.core.getUsersInChannel(channelId) as User[];
  }
  getServerInfo(): ServerInfo | null {
    return this.core.getServerInfo();
  }
  getSession(): SessionState | null {
    return this.core.getSession();
  }
  getCurrentChannel(): Channel | null {
    return this.core.getCurrentChannel() as Channel | null;
  }
  updateSession(updates: Partial<SessionState>): void {
    this.core.updateSession(updates);
  }
  reset(): void {
    this.core.reset();
  }

  /**
   * Returns the root channel. Tree traversal is done by following each
   * channel's `children` array via subsequent `getChannel()` calls.
   */
  getChannelTree(): Channel | null {
    return this.core.getChannel(0) as Channel | null;
  }
}
