/**
 * StateManager — channel tree, user roster, and own session state.
 *
 * Pure logic. Calls back into the host via the supplied `callbacks` object;
 * never touches the network or any Node-specific API.
 */

import type { mumbleproto } from '@munode/protocol';
import type { Channel, ServerInfo, SessionState, User } from '../types.js';

/**
 * Subset of `ClientCallbacks` that StateManager forwards to.
 * Kept narrow so it can be instantiated with a partial mock.
 */
export interface StateCallbacks {
  onServerSync?(message: mumbleproto.ServerSync): void;
  onServerConfig?(message: mumbleproto.ServerConfig): void;
  onChannelState?(message: mumbleproto.ChannelState): void;
  onChannelRemove?(message: mumbleproto.ChannelRemove): void;
  onUserState?(message: mumbleproto.UserState): void;
  onUserRemove?(message: mumbleproto.UserRemove): void;
  onPermissionDenied?(message: mumbleproto.PermissionDenied): void;
  onChannelDenied?(message: mumbleproto.PermissionDenied): void;
  onKicked?(message: mumbleproto.UserRemove): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // btoa is available in browsers and modern Node (>=16).
  if (typeof btoa === 'function') return btoa(bin);
  // Fallback for environments without btoa.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64');
  throw new Error('No base64 encoder available');
}

export class StateManager {
  private callbacks: StateCallbacks;

  private serverInfo: ServerInfo | null = null;
  private channels: Map<number, Channel> = new Map();
  private users: Map<number, User> = new Map();
  private session: SessionState | null = null;

  constructor(callbacks: StateCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: StateCallbacks): void {
    this.callbacks = callbacks;
  }

  reset(): void {
    this.serverInfo = null;
    this.channels.clear();
    this.users.clear();
    this.session = null;
  }

  handleServerSync(message: mumbleproto.ServerSync): void {
    const existingUser = this.users.get(message.session ?? 0);
    this.session = {
      session: message.session ?? 0,
      channel_id: existingUser?.channel_id ?? 0,
      mute: existingUser?.mute ?? false,
      deaf: existingUser?.deaf ?? false,
      self_mute: existingUser?.self_mute ?? false,
      self_deaf: existingUser?.self_deaf ?? false,
      suppress: existingUser?.suppress ?? false,
      recording: existingUser?.recording ?? false,
      priority_speaker: existingUser?.priority_speaker ?? false,
      listeningChannels: [],
    };

    if (!this.channels.has(0)) {
      this.channels.set(0, {
        channel_id: 0,
        parent: -1,
        name: 'Root',
        description: '',
        temporary: false,
        position: 0,
        links: [],
        max_users: 0,
        children: [],
      });
    }

    if (message.welcome_text) {
      this.serverInfo = {
        ...(this.serverInfo ?? ({} as ServerInfo)),
        welcomeText: message.welcome_text,
      } as ServerInfo;
    }

    this.callbacks.onServerSync?.(message);
  }

  handleServerConfig(message: mumbleproto.ServerConfig): void {
    this.serverInfo = {
      version: this.serverInfo?.version ?? 0,
      release: this.serverInfo?.release ?? '',
      os: this.serverInfo?.os ?? '',
      maxBandwidth: message.max_bandwidth ?? 0,
      maxUsers: message.max_users ?? 0,
      welcomeText: message.welcome_text ?? '',
      allowHtml: message.allow_html ?? false,
      messageLength: message.message_length ?? 0,
    };
    this.callbacks.onServerConfig?.(message);
  }

  handleChannelState(message: mumbleproto.ChannelState): void {
    const channelId = message.channel_id!;
    const existing = this.channels.get(channelId);

    let channelLinks: number[];
    if (
      (message.links_add && message.links_add.length > 0) ||
      (message.links_remove && message.links_remove.length > 0)
    ) {
      channelLinks = [...(existing?.links ?? [])];
      if (message.links_add) {
        for (const id of message.links_add) {
          if (!channelLinks.includes(id)) channelLinks.push(id);
        }
      }
      if (message.links_remove) {
        const toRemove = new Set(message.links_remove);
        channelLinks = channelLinks.filter((id) => !toRemove.has(id));
      }
    } else if (message.links && message.links.length > 0) {
      channelLinks = message.links;
    } else {
      channelLinks = existing?.links ?? [];
    }

    const channel: Channel = {
      channel_id: channelId,
      parent: message.parent !== undefined ? message.parent : (existing?.parent ?? 0),
      name: message.name !== undefined ? message.name : (existing?.name ?? ''),
      description: message.description !== undefined ? message.description : (existing?.description ?? ''),
      temporary: message.temporary !== undefined ? message.temporary : (existing?.temporary ?? false),
      position: message.position !== undefined ? message.position : (existing?.position ?? 0),
      links: channelLinks,
      max_users: message.max_users !== undefined ? message.max_users : (existing?.max_users ?? 0),
      children: existing?.children ?? [],
    };

    if (message.parent !== undefined) {
      const oldParent = existing?.parent;
      if (oldParent !== undefined && oldParent !== message.parent) {
        const oldP = this.channels.get(oldParent);
        if (oldP) oldP.children = oldP.children.filter((id) => id !== channelId);
      }
      const newP = this.channels.get(message.parent);
      if (newP && !newP.children.includes(channelId)) {
        newP.children.push(channelId);
      }
    }

    this.channels.set(channelId, channel);
    this.callbacks.onChannelState?.(message);
  }

  handleChannelRemove(message: mumbleproto.ChannelRemove): void {
    const channelId = message.channel_id!;
    const channel = this.channels.get(channelId);
    if (!channel) return;

    const parent = this.channels.get(channel.parent);
    if (parent) parent.children = parent.children.filter((id) => id !== channelId);
    this.channels.delete(channelId);

    this.callbacks.onChannelRemove?.(message);
  }

  handleUserState(message: mumbleproto.UserState): void {
    const session = message.session!;
    const existing = this.users.get(session);

    const user: User = {
      session,
      user_id: message.user_id ?? existing?.user_id,
      name: message.name ?? existing?.name ?? '',
      channel_id: message.channel_id !== undefined ? message.channel_id : (existing?.channel_id ?? 0),
      mute: message.mute !== undefined ? message.mute : (existing?.mute ?? false),
      deaf: message.deaf !== undefined ? message.deaf : (existing?.deaf ?? false),
      suppress: message.suppress !== undefined ? message.suppress : (existing?.suppress ?? false),
      self_mute: message.self_mute !== undefined ? message.self_mute : (existing?.self_mute ?? false),
      self_deaf: message.self_deaf !== undefined ? message.self_deaf : (existing?.self_deaf ?? false),
      recording: message.recording !== undefined ? message.recording : (existing?.recording ?? false),
      priority_speaker:
        message.priority_speaker !== undefined ? message.priority_speaker : (existing?.priority_speaker ?? false),
      hash: message.hash ?? existing?.hash,
      comment: message.comment ?? existing?.comment,
      comment_hash: message.comment_hash ? bytesToBase64(message.comment_hash) : existing?.comment_hash,
      texture: message.texture ? new Uint8Array(message.texture) : existing?.texture,
      texture_hash: message.texture_hash ? bytesToBase64(message.texture_hash) : existing?.texture_hash,
    };

    if (this.session && this.session.session === session) {
      if (user.user_id !== undefined) this.session.user_id = user.user_id;
      this.session.channel_id = user.channel_id;
      this.session.mute = user.mute;
      this.session.deaf = user.deaf;
      this.session.suppress = user.suppress;
      this.session.self_mute = user.self_mute;
      this.session.self_deaf = user.self_deaf;
      this.session.recording = user.recording;
      this.session.priority_speaker = user.priority_speaker;
      if (message.listening_channel_add && message.listening_channel_add.length > 0) {
        this.session.listeningChannels = message.listening_channel_add;
      }
    }

    this.users.set(session, user);
    this.callbacks.onUserState?.(message);
  }

  handleUserRemove(message: mumbleproto.UserRemove): void {
    const session = message.session!;
    if (this.users.has(session)) {
      this.users.delete(session);
      this.callbacks.onUserRemove?.(message);
    }
    if (this.session && this.session.session === session) {
      this.callbacks.onKicked?.(message);
    }
  }

  handlePermissionDenied(message: mumbleproto.PermissionDenied): void {
    this.callbacks.onPermissionDenied?.(message);
    if (message.type === 3 /* DenyType.ChannelName */) {
      this.callbacks.onChannelDenied?.(message);
    }
  }

  // Queries -------------------------------------------------------------

  getChannel(id: number): Channel | null {
    return this.channels.get(id) ?? null;
  }
  getChannels(): Channel[] {
    return Array.from(this.channels.values());
  }
  getUser(session: number): User | null {
    return this.users.get(session) ?? null;
  }
  getUsers(): User[] {
    return Array.from(this.users.values());
  }
  getUsersInChannel(channelId: number): User[] {
    return this.getUsers().filter((u) => u.channel_id === channelId);
  }
  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }
  getSession(): SessionState | null {
    return this.session;
  }
  getCurrentChannel(): Channel | null {
    if (!this.session) return null;
    return this.getChannel(this.session.channel_id);
  }
  updateSession(updates: Partial<SessionState>): void {
    if (this.session) Object.assign(this.session, updates);
  }
}
