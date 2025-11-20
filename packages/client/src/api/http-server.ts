/**
 * HTTP REST API Server
 *
 * 主要职责:
 * - 提供 RESTful API 接口
 * - 使用路由表将请求直接交给 dispatcher 处理
 * - CORS 支持
 * - 认证中间件
 */

import Fastify, { FastifyInstance } from 'fastify';
import type { MumbleClient } from '../core/mumble-client.js';
import { ApiDispatcher } from './dispatcher.js';
import type { HttpServerOptions } from '../types/api-types.js';

interface RouteConfig {
  path: string;
  method: string;
  action: string;
  paramMapper?: (request: any) => any;
}

export class HttpServer {
  private fastify: FastifyInstance;
  private client: MumbleClient;
  private dispatcher: ApiDispatcher;
  private options: HttpServerOptions;

  private routes: RouteConfig[] = [
    { path: '/client/connect', method: 'POST', action: 'connect' },
    { path: '/client/disconnect', method: 'POST', action: 'disconnect' },
    { path: '/client/status', method: 'GET', action: 'getStatus' },
    { path: '/channel/join', method: 'POST', action: 'joinChannel' },
    { path: '/channel/create', method: 'POST', action: 'createChannel' },
    { path: '/channel/:id', method: 'DELETE', action: 'deleteChannel', paramMapper: (req) => ({ channelId: req.params.id }) },
    { path: '/channel/:id', method: 'PUT', action: 'updateChannel', paramMapper: (req) => ({ channelId: req.params.id, ...req.body }) },
    { path: '/channel/list', method: 'GET', action: 'getChannels' },
    { path: '/channel/listen/add', method: 'POST', action: 'addListeningChannel' },
    { path: '/channel/listen/remove', method: 'POST', action: 'removeListeningChannel' },
    { path: '/channel/listen/clear', method: 'POST', action: 'clearListeningChannels' },
    { path: '/channel/listen/list', method: 'GET', action: 'getListeningChannels' },
    { path: '/voice/target/set', method: 'POST', action: 'setVoiceTarget' },
    { path: '/voice/target/remove', method: 'POST', action: 'removeVoiceTarget' },
    { path: '/plugin/data/send', method: 'POST', action: 'sendPluginData' },
    { path: '/context/action/register', method: 'POST', action: 'registerContextAction' },
    { path: '/context/action/execute', method: 'POST', action: 'executeContextAction' },
    { path: '/webhook/add', method: 'POST', action: 'addWebhook' },
    { path: '/webhook/remove', method: 'POST', action: 'removeWebhook' },
    { path: '/webhook/list', method: 'GET', action: 'getWebhooks' },
    { path: '/acl/query/:channelId', method: 'GET', action: 'queryACL', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId) }) },
    { path: '/acl/save', method: 'POST', action: 'saveACL' },
    { path: '/acl/check/:channelId/:permission', method: 'GET', action: 'checkPermission', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId), permission: parseInt(req.params.permission), userSession: req.query.userSession ? parseInt(req.query.userSession) : undefined }) },
    { path: '/acl/user-permissions/:channelId', method: 'GET', action: 'getUserPermissions', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId), userSession: req.query.userSession ? parseInt(req.query.userSession) : undefined }) },
    { path: '/acl/entry/add', method: 'POST', action: 'addACLEntry' },
    { path: '/acl/entry/:channelId/:index', method: 'DELETE', action: 'removeACLEntry', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId), entryIndex: parseInt(req.params.index) }) },
    { path: '/acl/entry/:channelId/:index', method: 'PUT', action: 'updateACLEntry', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId), entryIndex: parseInt(req.params.index), updates: req.body }) },
    { path: '/acl/group/create', method: 'POST', action: 'createChannelGroup' },
    { path: '/acl/group/:channelId/:groupName', method: 'DELETE', action: 'deleteChannelGroup', paramMapper: (req) => ({ channelId: parseInt(req.params.channelId), groupName: req.params.groupName }) },
    { path: '/acl/group/add-user', method: 'POST', action: 'addUserToGroup' },
    { path: '/acl/group/remove-user', method: 'POST', action: 'removeUserFromGroup' },
    { path: '/user/list', method: 'GET', action: 'getUsers' },
    { path: '/user/kick', method: 'POST', action: 'kickUser' },
    { path: '/user/ban', method: 'POST', action: 'banUser' },
    { path: '/user/state', method: 'PUT', action: 'updateUserState' },
    { path: '/message/send', method: 'POST', action: 'sendMessage' },
    { path: '/message/history', method: 'GET', action: 'getMessageHistory' },
    { path: '/audio/send', method: 'POST', action: 'sendAudio' },
    { path: '/audio/stream/start', method: 'POST', action: 'startAudioStream' },
    { path: '/audio/stream/stop', method: 'POST', action: 'stopAudioStream' },
    { path: '/config', method: 'GET', action: 'getConfig' },
    { path: '/config', method: 'PUT', action: 'updateConfig' },
  ];

  constructor(client: MumbleClient, options: HttpServerOptions) {
    this.client = client;
    this.options = options;
    this.dispatcher = new ApiDispatcher();
    this.fastify = Fastify({
      logger: options.logger || false
    });

    this.setupMiddlewares();
    this.setupRoutes();
  }

  /**
   * 设置中间件
   */
  private setupMiddlewares(): void {
    // CORS 支持
    if (this.options.cors) {
      // 可以使用 @fastify/cors 插件
      // this.fastify.register(require('@fastify/cors'));
    }

    // 认证中间件可在此添加
    // this.fastify.addHook('preHandler', async (request, reply) => {
    //   // 检查 Bearer Token
    // });
  }

  /**
   * 设置路由
   */
  private setupRoutes(): void {
    for (const route of this.routes) {
      this.fastify[route.method.toLowerCase()](route.path, async (request) => {
        const params = route.paramMapper ? route.paramMapper(request) : (route.method === 'GET' ? request.query : request.body);
        const result = await this.dispatcher.dispatch(
          { action: route.action, params },
          { client: this.client, source: 'http' }
        );
        return result;
      });
    }
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      await this.fastify.listen({
        host: this.options.host,
        port: this.options.port
      });
      console.log(`HTTP API server listening on ${this.options.host}:${this.options.port}`);
    } catch (error) {
      console.error('Failed to start HTTP server:', error);
      throw error;
    }
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    await this.fastify.close();
  }
}

/**
 * 启动 HTTP 服务器的便捷函数
 */
export async function startHttpServer(
  client: MumbleClient,
  options: HttpServerOptions
): Promise<HttpServer> {
  const server = new HttpServer(client, options);
  await server.start();
  return server;
}
