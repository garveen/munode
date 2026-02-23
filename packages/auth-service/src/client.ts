/**
 * AuthServiceClient - TypeScript 认证服务客户端
 *
 * 连接到 Rust Hub 暴露的 WebSocket 认证服务端口，接收认证请求并
 * 将结果回传给 Hub。
 *
 * 用法示例见 README.md 或 index.ts 的 createAuthService() 函数。
 */

import WebSocket from 'ws';
import { createLogger } from '@munode/common';
import type { Logger } from '@munode/common';
import {
  AuthServicePacket_Type,
  encodePacket,
  decodePacket,
  type AuthRequest,
  type AuthResponse,
} from './protocol.js';
import { AuthServicePacket } from '@munode/protocol';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 认证回调函数类型。
 * 用户在配置中提供此函数，Hub 收到客户端登录请求时会调用它。
 *
 * @param request  来自 Hub 的认证请求，包含用户名、密码、IP 等信息。
 * @returns        认证结果。success=true 表示允许；success=false 表示拒绝。
 */
export type AuthCallback = (request: AuthRequest) => Promise<AuthResponse>;

/**
 * AuthServiceClient 的配置。
 */
export interface AuthServiceConfig {
  /** Hub 认证服务的 WebSocket 地址，例如 "ws://127.0.0.1:8444" */
  hubUrl: string;
  /**
   * 认证回调函数。Hub 每次需要认证一个 Mumble 客户端时调用。
   * 可以在此处接入数据库查询、HTTP 验证、LDAP 等任意后端。
   */
  onAuth: AuthCallback;
  /** 服务名称，用于日志和 Hub 侧识别（默认 "ts-auth-service"） */
  serviceName?: string;
  /** 服务版本（默认 "1.0.0"） */
  serviceVersion?: string;
  /** 断线后重连间隔毫秒（默认 5000） */
  reconnectIntervalMs?: number;
  /** 日志级别（默认 "info"） */
  logLevel?: string;
}

// ---------------------------------------------------------------------------
// AuthServiceClient
// ---------------------------------------------------------------------------

export class AuthServiceClient {
  private config: Required<Omit<AuthServiceConfig, 'onAuth'>> & Pick<AuthServiceConfig, 'onAuth'>;
  private ws: WebSocket | null = null;
  private logger: Logger;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(config: AuthServiceConfig) {
    this.config = {
      serviceName: 'ts-auth-service',
      serviceVersion: '1.0.0',
      reconnectIntervalMs: 5000,
      logLevel: 'info',
      ...config,
    };

    this.logger = createLogger({
      service: this.config.serviceName,
      level: this.config.logLevel,
    });
  }

  /**
   * 启动服务并连接到 Hub。
   * 会自动在断线时重试。
   */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /**
   * 停止服务并关闭连接。不再自动重连。
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.logger.info('Auth service stopped');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;

    this.logger.info(`Connecting to Hub auth service at ${this.config.hubUrl}…`);

    const ws = new WebSocket(this.config.hubUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.logger.info('Connected to Hub auth service');
      this.sendHello();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
      this.handleMessage(buf);
    });

    ws.on('close', (code, reason) => {
      this.logger.warn(`Disconnected from Hub auth service (code=${code}, reason=${reason.toString()})`);
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`WebSocket error: ${err.message}`);
      // The 'close' event will fire after this, triggering reconnect.
    });
  }

  private sendHello(): void {
    const packet: AuthServicePacket = {
      type: AuthServicePacket_Type.HELLO,
      hello: {
        service_name: this.config.serviceName,
        version: this.config.serviceVersion,
      },
    };
    this.sendRaw(encodePacket(packet));
  }

  private handleMessage(data: Buffer): void {
    let packet: AuthServicePacket;
    try {
      packet = decodePacket(data);
    } catch (err) {
      this.logger.error(`Failed to decode packet: ${(err as Error).message}`);
      return;
    }

    switch (packet.type) {
      case AuthServicePacket_Type.AUTH_REQUEST:
        if (packet.auth_request) {
          void this.handleAuthRequest(packet.auth_request);
        }
        break;

      case AuthServicePacket_Type.PING:
        this.sendRaw(encodePacket({ type: AuthServicePacket_Type.PONG }));
        break;

      case AuthServicePacket_Type.PONG:
        // nothing
        break;

      default:
        this.logger.warn(`Unexpected packet type from Hub: ${packet.type}`);
    }
  }

  private async handleAuthRequest(request: AuthRequest): Promise<void> {
    this.logger.info(
      `Auth request: user="${request.username}" session=${request.session_id} ip=${request.ip_address}`,
    );

    let response: AuthResponse;
    try {
      response = await this.config.onAuth(request);
    } catch (err) {
      this.logger.error(`onAuth callback threw: ${(err as Error).message}`);
      response = {
        request_id: request.request_id,
        success: false,
        reason: 'Internal authentication error',
        reject_type: 8, // AuthenticatorFail
      };
    }

    // Always ensure request_id is echoed back.
    response = { ...response, request_id: request.request_id };

    const packet: AuthServicePacket = {
      type: AuthServicePacket_Type.AUTH_RESPONSE,
      auth_response: response,
    };

    this.sendRaw(encodePacket(packet));

    this.logger.info(
      `Auth response: user="${request.username}" success=${response.success}${
        response.reason ? ` reason="${response.reason}"` : ''
      }`,
    );
  }

  private sendRaw(data: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectIntervalMs);
  }
}
