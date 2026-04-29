/**
 * MumbleClientCore — platform-neutral Mumble client engine.
 *
 * Owns:
 *   - frame assembler / dispatcher
 *   - StateManager (channels / users / session)
 *   - JitterBufferPool (per-talker voice buffering)
 *
 * Does NOT own:
 *   - any socket (TCP/UDP/WebSocket) — host provides `send` callback
 *   - OCB2 encryption — host hooks `onCryptSetup`
 *   - codec encode/decode — `onVoiceFrame` delivers raw Opus bytes
 *   - reconnect logic — host transport is responsible
 */

import { mumbleproto, MessageType } from '@munode/protocol';
import type { ClientOptions } from './client-options.js';
import { dispatchFrame } from './protocol/dispatcher.js';
import { FrameAssembler, wrapFrame } from './protocol/framing.js';
import { encodeOutgoingOpusVoicePacket } from './protocol/voice-packet.js';
import { StateManager } from './state/state-manager.js';
import { JitterBufferPool, type JitterStats } from './voice/jitter-buffer.js';
import type {
  AuthOptions,
  Channel,
  ChannelStateUpdate,
  MessageTarget,
  ServerInfo,
  SessionState,
  User,
  UserStateUpdate,
  VoiceFrame,
} from './types.js';

/** Mumble client protocol version we advertise on connect. */
const CLIENT_RELEASE = 'munode-client-core';
const CLIENT_VERSION_MAJOR = 1;
const CLIENT_VERSION_MINOR = 5;
const CLIENT_VERSION_PATCH = 0;

/**
 * Opus voice target wrap-around at 24-bit (Mumble protocol restriction is
 * effectively unlimited but we keep stats sane).
 */
const SEQ_WRAP = 0xffffff;

export class MumbleClientCore {
  private options: ClientOptions;
  private readonly state: StateManager;
  private readonly assembler: FrameAssembler = new FrameAssembler();
  private readonly jitter: JitterBufferPool = new JitterBufferPool();

  private outgoingSeq: number = 0;

  private authPromise: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;
  private auth: AuthOptions | null = null;

  constructor(options: ClientOptions) {
    if (typeof options.send !== 'function') {
      throw new Error('ClientOptions.send is required');
    }
    this.options = options;
    this.state = new StateManager({
      onServerSync: (m) => options.onServerSync?.(m),
      onServerConfig: (m) => options.onServerConfig?.(m),
      onChannelState: (m) => options.onChannelState?.(m),
      onChannelRemove: (m) => options.onChannelRemove?.(m),
      onUserState: (m) => options.onUserState?.(m),
      onUserRemove: (m) => options.onUserRemove?.(m),
      onPermissionDenied: (m) => options.onPermissionDenied?.(m),
      onChannelDenied: (m) => options.onChannelDenied?.(m),
      onKicked: (m) => options.onKicked?.(m),
    });
  }

  // ---------------------------------------------------------------------
  // Host-driven inputs
  // ---------------------------------------------------------------------

  /** Push raw bytes received from the transport. */
  receive(data: Uint8Array): void {
    const frames = this.assembler.push(data);
    for (const frame of frames) {
      dispatchFrame(
        {
          options: this.options,
          state: this.state,
          handleVoiceFrame: (vf) => this.onVoiceFrame(vf),
          handleReject: (m) => this.onReject(m),
          handleServerSync: (m) => this.onAuthSuccess(m),
        },
        frame.type,
        frame.payload,
      );
    }
  }

  /** Notify the core that the underlying transport has closed. */
  onTransportClosed(reason?: string): void {
    if (this.authPromise) {
      this.authPromise.reject(new Error(reason ?? 'Transport closed during authentication'));
      this.clearAuth();
    }
    this.options.onDisconnected?.(reason);
  }

  /** Reset all state. Call before reusing the core after a reconnect. */
  reset(): void {
    this.assembler.reset();
    this.state.reset();
    this.jitter.reset();
    this.outgoingSeq = 0;
    this.clearAuth();
  }

  // ---------------------------------------------------------------------
  // High-level operations
  // ---------------------------------------------------------------------

  /**
   * Send the initial handshake (`Version` + `Authenticate`) and wait for
   * `ServerSync` (resolves) or `Reject` (rejects).
   */
  async authenticate(opts: AuthOptions, timeoutMs: number = 30000): Promise<void> {
    this.auth = opts;
    await this.sendVersion();
    await this.sendAuthenticate(opts);
    if (opts.preConnectState) {
      await this.sendUserState({
        self_mute: opts.preConnectState.self_mute,
        self_deaf: opts.preConnectState.self_deaf,
      });
    }
    return new Promise<void>((resolve, reject) => {
      this.authPromise = { resolve, reject };
      this.authTimeout = setTimeout(() => {
        this.clearAuth();
        reject(new Error('Authentication timeout'));
      }, timeoutMs);
    });
  }

  async sendVersion(): Promise<void> {
    const payload = mumbleproto.Version.encode({
      // Legacy 32-bit version field: major (16 bits) | minor (8 bits) | patch (8 bits)
      version_v1:
        (CLIENT_VERSION_MAJOR << 16) | (CLIENT_VERSION_MINOR << 8) | CLIENT_VERSION_PATCH,
      release: CLIENT_RELEASE,
      os: 'unknown',
      os_version: '',
    } as Partial<mumbleproto.Version>).finish();
    await this.sendFramed(MessageType.Version, payload);
  }

  async sendAuthenticate(opts: AuthOptions): Promise<void> {
    const payload = mumbleproto.Authenticate.encode({
      username: opts.username,
      password: opts.password ?? '',
      tokens: opts.tokens ?? [],
      celt_versions: [],
      opus: true,
    } as Partial<mumbleproto.Authenticate>).finish();
    await this.sendFramed(MessageType.Authenticate, payload);
  }

  async sendPing(stats?: { tcpPackets?: number; udpPackets?: number }): Promise<void> {
    const jitterStats = this.jitter.consumeStats();
    const ping: Partial<mumbleproto.Ping> = {
      timestamp: Date.now(),
      good: jitterStats.good,
      late: jitterStats.late,
      lost: jitterStats.lost,
      resync: jitterStats.resync,
      tcp_packets: stats?.tcpPackets,
      udp_packets: stats?.udpPackets,
    };
    const payload = mumbleproto.Ping.encode(ping as mumbleproto.Ping).finish();
    await this.sendFramed(MessageType.Ping, payload);
  }

  async joinChannel(channelId: number): Promise<void> {
    return this.sendUserState({ channel_id: channelId });
  }

  async sendUserState(update: UserStateUpdate): Promise<void> {
    const full = {
      temporary_access_tokens: [] as string[],
      listening_channel_add: [] as number[],
      listening_channel_remove: [] as number[],
      ...update,
    };
    const payload = mumbleproto.UserState.encode(full as mumbleproto.UserState).finish();
    await this.sendFramed(MessageType.UserState, payload);
  }

  async sendChannelState(update: ChannelStateUpdate): Promise<void> {
    const full = {
      links: update.links ?? [],
      links_add: update.links_add ?? [],
      links_remove: update.links_remove ?? [],
      ...update,
    };
    const payload = mumbleproto.ChannelState.encode(full as mumbleproto.ChannelState).finish();
    await this.sendFramed(MessageType.ChannelState, payload);
  }

  async removeChannel(channelId: number): Promise<void> {
    const payload = mumbleproto.ChannelRemove.encode({ channel_id: channelId }).finish();
    await this.sendFramed(MessageType.ChannelRemove, payload);
  }

  async sendTextMessage(target: MessageTarget, message: string): Promise<void> {
    const payload = mumbleproto.TextMessage.encode({
      channel_id: target.channelId !== undefined && !target.tree ? [target.channelId] : [],
      session: target.userId !== undefined ? [target.userId] : [],
      message,
      tree_id: target.tree && target.channelId !== undefined ? [target.channelId] : [],
    } as Partial<mumbleproto.TextMessage>).finish();
    await this.sendFramed(MessageType.TextMessage, payload);
  }

  async setSelfMute(mute: boolean): Promise<void> {
    return this.sendUserState({ self_mute: mute });
  }
  async setSelfDeaf(deaf: boolean): Promise<void> {
    return this.sendUserState({ self_deaf: deaf, ...(deaf ? { self_mute: true } : {}) });
  }
  async setRecording(recording: boolean): Promise<void> {
    return this.sendUserState({ recording });
  }
  async addListeningChannel(channelId: number): Promise<void> {
    return this.sendUserState({ listening_channel_add: [channelId] });
  }
  async removeListeningChannel(channelId: number): Promise<void> {
    return this.sendUserState({ listening_channel_remove: [channelId] });
  }

  async setVoiceTarget(id: number, targets: mumbleproto.VoiceTarget_Target[]): Promise<void> {
    if (id < 0 || id > 30) {
      throw new Error(`VoiceTarget id must be in [0, 30], got ${id}`);
    }
    const payload = mumbleproto.VoiceTarget.encode({ id, targets } as mumbleproto.VoiceTarget).finish();
    await this.sendFramed(MessageType.VoiceTarget, payload);
  }

  async sendPermissionQuery(channelId: number): Promise<void> {
    const payload = mumbleproto.PermissionQuery.encode({
      channel_id: channelId,
    } as Partial<mumbleproto.PermissionQuery>).finish();
    await this.sendFramed(MessageType.PermissionQuery, payload);
  }

  async kickUser(session: number, reason?: string, ban: boolean = false): Promise<void> {
    const payload = mumbleproto.UserRemove.encode({
      session,
      reason,
      ban,
    } as Partial<mumbleproto.UserRemove>).finish();
    await this.sendFramed(MessageType.UserRemove, payload);
  }

  async requestBlob(opts: {
    sessionTexture?: number[];
    sessionComment?: number[];
    channelDescription?: number[];
  }): Promise<void> {
    const payload = mumbleproto.RequestBlob.encode({
      session_texture: opts.sessionTexture ?? [],
      session_comment: opts.sessionComment ?? [],
      channel_description: opts.channelDescription ?? [],
    } as Partial<mumbleproto.RequestBlob>).finish();
    await this.sendFramed(MessageType.RequestBlob, payload);
  }

  async sendUserStats(session: number, statsOnly: boolean = false): Promise<void> {
    const payload = mumbleproto.UserStats.encode({
      session,
      stats_only: statsOnly,
    } as Partial<mumbleproto.UserStats>).finish();
    await this.sendFramed(MessageType.UserStats, payload);
  }

  async sendACL(message: Partial<mumbleproto.ACL>): Promise<void> {
    const payload = mumbleproto.ACL.encode({
      groups: [],
      acls: [],
      ...message,
    } as mumbleproto.ACL).finish();
    await this.sendFramed(MessageType.ACL, payload);
  }

  async queryUsers(ids: number[], names: string[]): Promise<void> {
    const payload = mumbleproto.QueryUsers.encode({
      ids,
      names,
    } as Partial<mumbleproto.QueryUsers>).finish();
    await this.sendFramed(MessageType.QueryUsers, payload);
  }

  async sendContextAction(action: string, session?: number, channelId?: number): Promise<void> {
    const payload = mumbleproto.ContextAction.encode({
      action,
      session,
      channel_id: channelId,
    } as Partial<mumbleproto.ContextAction>).finish();
    await this.sendFramed(MessageType.ContextAction, payload);
  }

  async sendPluginData(dataId: string, data: Uint8Array, receivers: number[] = []): Promise<void> {
    const session = this.state.getSession()?.session ?? 0;
    const payload = mumbleproto.PluginDataTransmission.encode({
      senderSession: session,
      receiverSessions: receivers,
      data,
      dataID: dataId,
    } as Partial<mumbleproto.PluginDataTransmission>).finish();
    await this.sendFramed(MessageType.PluginDataTransmission, payload);
  }

  /**
   * Send an Opus voice frame.
   *
   * If the host provides `sendVoiceUdp`, the packet is sent there (UDP path);
   * otherwise it is tunneled over TCP via `UDPTunnel`. UDP encryption is the
   * host's responsibility.
   */
  async sendVoice(opusFrame: Uint8Array, target: number = 0, terminator: boolean = false): Promise<void> {
    const seq = this.outgoingSeq;
    this.outgoingSeq = (this.outgoingSeq + 1) & SEQ_WRAP;

    const packet = encodeOutgoingOpusVoicePacket({
      target,
      sequence: seq,
      opusFrame,
      terminator,
    });

    if (this.options.sendVoiceUdp) {
      const result = await this.options.sendVoiceUdp(packet);
      if (result !== false) return;
    }

    // Fallback: TCP tunnel.
    await this.sendFramed(MessageType.UDPTunnel, packet);
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  getSession(): SessionState | null {
    return this.state.getSession();
  }
  getServerInfo(): ServerInfo | null {
    return this.state.getServerInfo();
  }
  getChannel(id: number): Channel | null {
    return this.state.getChannel(id);
  }
  getChannels(): Channel[] {
    return this.state.getChannels();
  }
  getUser(session: number): User | null {
    return this.state.getUser(session);
  }
  getUsers(): User[] {
    return this.state.getUsers();
  }
  getUsersInChannel(channelId: number): User[] {
    return this.state.getUsersInChannel(channelId);
  }
  getStateManager(): StateManager {
    return this.state;
  }

  /** Pop the next ready voice frame for `sessionId`, or null. */
  popVoiceFrame(sessionId: number): VoiceFrame | null {
    return this.jitter.pop(sessionId);
  }
  /** Currently buffered talkers. */
  activeVoiceSessions(): number[] {
    return this.jitter.activeSessions();
  }
  /** Consume jitter stats (also done automatically by `sendPing`). */
  consumeJitterStats(): JitterStats {
    return this.jitter.consumeStats();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Wrap and send a fully-encoded protobuf payload as a TCP frame.
   * Public so hosts can send custom messages if needed.
   */
  async sendFramed(type: number, payload: Uint8Array): Promise<void> {
    const frame = wrapFrame(type, payload);
    await this.options.send(frame);
  }

  private onVoiceFrame(frame: VoiceFrame): void {
    this.jitter.push(frame);
    this.options.onVoiceFrame?.(frame);
  }

  private onAuthSuccess(message: mumbleproto.ServerSync): void {
    this.options.onAuthenticated?.(message);
    if (this.authPromise) {
      this.authPromise.resolve();
      this.clearAuth();
    }
  }

  private onReject(message: mumbleproto.Reject): void {
    const info = {
      type: message.type ?? 0,
      reason: message.reason ?? 'Unknown reason',
      message,
    };
    this.options.onAuthenticationFailed?.(info);
    if (this.authPromise) {
      this.authPromise.reject(new Error(`Authentication failed: ${info.reason}`));
      this.clearAuth();
    }
  }

  private clearAuth(): void {
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
    this.authPromise = null;
  }

  /** Pending auth options (e.g. for use by hosts that need to inspect tokens). */
  getAuthOptions(): AuthOptions | null {
    return this.auth;
  }
}
