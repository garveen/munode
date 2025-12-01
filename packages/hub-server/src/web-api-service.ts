/**
 * Hub Web API Service
 * 
 * 提供 Hub 统计数据的 HTTP API，与 Edge 通信接口分离
 * 
 * API 端点：
 * - GET /api/status - 获取 Hub 状态
 * - GET /api/edges - 获取连接的 Edge 列表及状态
 * - GET /api/edges/:id - 获取特定 Edge 的详细信息
 * - GET /api/stats - 获取 Hub 统计数据
 * - GET /api/topology - 获取网络拓扑信息
 */

import * as http from 'http';
import { createLogger } from '@munode/common';
import type { WebApiConfig } from './types.js';
import type { ServiceRegistry } from './registry.js';
import type { GlobalSessionManager } from './session-manager.js';
import type { NetworkTopologyManager } from './network-topology-manager.js';

const logger = createLogger({ service: 'hub-web-api' });

/**
 * Hub 状态响应
 */
interface HubStatusResponse {
  status: 'running' | 'stopped';
  uptime: number;
  version: string;
  serverId: number;
  timestamp: number;
}

/**
 * Edge 状态信息
 */
interface EdgeStatusInfo {
  id: number;
  name: string;
  host: string;
  port: number;
  voicePort: number;
  region?: string;
  capacity: number;
  currentLoad: number;
  lastSeen: number;
  isOnline: boolean;
  stats?: {
    connectedClients: number;
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
  };
}

/**
 * Hub 统计数据
 */
interface HubStatsResponse {
  edges: {
    total: number;
    online: number;
    offline: number;
  };
  sessions: {
    total: number;
    active: number;
  };
  voiceRouting?: {
    enabled: boolean;
    totalRoutes: number;
    activeRelays: number;
  };
  timestamp: number;
}

/**
 * Web API Service
 */
export class WebApiService {
  private server: http.Server | null = null;
  private config: WebApiConfig;
  private registry: ServiceRegistry;
  private sessionManager: GlobalSessionManager;
  private networkTopologyManager?: NetworkTopologyManager;
  private startTime: number = 0;
  private serverId: number;

  constructor(
    config: WebApiConfig,
    serverId: number,
    registry: ServiceRegistry,
    sessionManager: GlobalSessionManager,
    networkTopologyManager?: NetworkTopologyManager
  ) {
    this.config = config;
    this.serverId = serverId;
    this.registry = registry;
    this.sessionManager = sessionManager;
    this.networkTopologyManager = networkTopologyManager;
  }

  /**
   * 启动 Web API 服务
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Web API service is disabled');
      return;
    }

    this.startTime = Date.now();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    const host = this.config.host || '0.0.0.0';
    const port = this.config.port;

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info(`Web API service started on ${host}:${port}`);
        resolve();
      });

      this.server!.on('error', (error) => {
        logger.error('Web API server error:', error);
        reject(error);
      });
    });
  }

  /**
   * 停止 Web API 服务
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Web API service stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * 设置 NetworkTopologyManager（可在启动后设置）
   */
  setNetworkTopologyManager(manager: NetworkTopologyManager): void {
    this.networkTopologyManager = manager;
  }

  /**
   * 处理 HTTP 请求
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS 处理
    if (this.config.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // 只允许 GET 请求
    if (req.method !== 'GET') {
      this.sendError(res, 405, 'Method Not Allowed');
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // 路由处理
      if (pathname === '/api/status') {
        this.handleStatus(res);
      } else if (pathname === '/api/edges') {
        this.handleEdgesList(res);
      } else if (pathname.startsWith('/api/edges/')) {
        const edgeId = parseInt(pathname.split('/')[3], 10);
        if (isNaN(edgeId)) {
          this.sendError(res, 400, 'Invalid edge ID');
        } else {
          this.handleEdgeDetail(res, edgeId);
        }
      } else if (pathname === '/api/stats') {
        this.handleStats(res);
      } else if (pathname === '/api/topology') {
        this.handleTopology(res);
      } else if (pathname === '/api/health') {
        this.handleHealth(res);
      } else {
        this.sendError(res, 404, 'Not Found');
      }
    } catch (error) {
      logger.error('Error handling request:', error);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  /**
   * GET /api/status - 获取 Hub 状态
   */
  private handleStatus(res: http.ServerResponse): void {
    const response: HubStatusResponse = {
      status: 'running',
      uptime: Date.now() - this.startTime,
      version: '0.1.0', // TODO: 从 package.json 读取
      serverId: this.serverId,
      timestamp: Date.now(),
    };

    this.sendJson(res, response);
  }

  /**
   * GET /api/edges - 获取 Edge 列表
   */
  private handleEdgesList(res: http.ServerResponse): void {
    const edges = this.registry.getAllEdges();
    const now = Date.now();
    const onlineThreshold = 30000; // 30秒无心跳视为离线

    const edgeList: EdgeStatusInfo[] = edges.map((edge) => ({
      id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      voicePort: edge.port + 1,
      region: edge.region,
      capacity: edge.capacity,
      currentLoad: edge.current_load,
      lastSeen: edge.last_seen,
      isOnline: now - edge.last_seen < onlineThreshold,
      stats: edge.stats ? {
        connectedClients: edge.stats.user_count || 0,
        bytesIn: edge.stats.bandwidth?.in || 0,
        bytesOut: edge.stats.bandwidth?.out || 0,
        packetsIn: 0, // 不在 ServerStats 中
        packetsOut: 0, // 不在 ServerStats 中
      } : undefined,
    }));

    this.sendJson(res, {
      total: edgeList.length,
      edges: edgeList,
      timestamp: now,
    });
  }

  /**
   * GET /api/edges/:id - 获取特定 Edge 详情
   */
  private handleEdgeDetail(res: http.ServerResponse, edgeId: number): void {
    const edge = this.registry.getEdge(edgeId);
    
    if (!edge) {
      this.sendError(res, 404, 'Edge not found');
      return;
    }

    const now = Date.now();
    const onlineThreshold = 30000;

    const edgeInfo: EdgeStatusInfo = {
      id: edge.server_id,
      name: edge.name,
      host: edge.host,
      port: edge.port,
      voicePort: edge.port + 1,
      region: edge.region,
      capacity: edge.capacity,
      currentLoad: edge.current_load,
      lastSeen: edge.last_seen,
      isOnline: now - edge.last_seen < onlineThreshold,
      stats: edge.stats ? {
        connectedClients: edge.stats.user_count || 0,
        bytesIn: edge.stats.bandwidth?.in || 0,
        bytesOut: edge.stats.bandwidth?.out || 0,
        packetsIn: 0,
        packetsOut: 0,
      } : undefined,
    };

    // 如果有网络拓扑信息，添加链接质量
    if (this.networkTopologyManager) {
      const allEdges = this.networkTopologyManager.getAllEdges();
      const links: Array<{ targetEdgeId: number; rtt: number; packetLoss: number; jitter: number }> = [];
      
      for (const targetId of allEdges) {
        if (targetId !== edgeId) {
          const link = this.networkTopologyManager.getLink(edgeId, targetId);
          if (link) {
            links.push({
              targetEdgeId: targetId,
              rtt: link.quality.rtt,
              packetLoss: link.quality.packetLoss,
              jitter: link.quality.jitter,
            });
          }
        }
      }

      this.sendJson(res, {
        ...edgeInfo,
        links,
        timestamp: now,
      });
    } else {
      this.sendJson(res, {
        ...edgeInfo,
        timestamp: now,
      });
    }
  }

  /**
   * GET /api/stats - 获取 Hub 统计
   */
  private handleStats(res: http.ServerResponse): void {
    const edges = this.registry.getAllEdges();
    const now = Date.now();
    const onlineThreshold = 30000;

    const onlineEdges = edges.filter(e => now - e.last_seen < onlineThreshold);
    const sessions = this.sessionManager.getAllSessions();

    const response: HubStatsResponse = {
      edges: {
        total: edges.length,
        online: onlineEdges.length,
        offline: edges.length - onlineEdges.length,
      },
      sessions: {
        total: sessions.length,
        active: sessions.length, // 所有 session 都是 active
      },
      timestamp: now,
    };

    // 添加语音路由统计
    if (this.networkTopologyManager && this.networkTopologyManager.isEnabled()) {
      const allEdges = this.networkTopologyManager.getAllEdges();
      let totalRoutes = 0;
      
      // 统计路由数
      for (const sourceId of allEdges) {
        for (const targetId of allEdges) {
          if (sourceId !== targetId) {
            const path = this.networkTopologyManager.findBestPath(sourceId, targetId);
            if (path) {
              totalRoutes++;
            }
          }
        }
      }

      response.voiceRouting = {
        enabled: true,
        totalRoutes,
        activeRelays: 0, // TODO: 实现中转统计
      };
    }

    this.sendJson(res, response);
  }

  /**
   * GET /api/topology - 获取网络拓扑
   */
  private handleTopology(res: http.ServerResponse): void {
    if (!this.networkTopologyManager) {
      this.sendJson(res, {
        enabled: false,
        message: 'Network topology manager not available',
        timestamp: Date.now(),
      });
      return;
    }

    const allEdges = this.networkTopologyManager.getAllEdges();
    const nodes: Array<{ id: number; name: string }> = [];
    const links: Array<{ source: number; target: number; rtt: number; packetLoss: number }> = [];

    // 获取节点信息
    for (const edgeId of allEdges) {
      const edge = this.registry.getEdge(edgeId);
      nodes.push({
        id: edgeId,
        name: edge?.name || `Edge ${edgeId}`,
      });
    }

    // 获取链接信息
    for (const sourceId of allEdges) {
      for (const targetId of allEdges) {
        if (sourceId < targetId) { // 避免重复
          const link = this.networkTopologyManager.getLink(sourceId, targetId);
          if (link) {
            links.push({
              source: sourceId,
              target: targetId,
              rtt: link.quality.rtt,
              packetLoss: link.quality.packetLoss,
            });
          }
        }
      }
    }

    this.sendJson(res, {
      enabled: this.networkTopologyManager.isEnabled(),
      nodes,
      links,
      timestamp: Date.now(),
    });
  }

  /**
   * GET /api/health - 健康检查
   */
  private handleHealth(res: http.ServerResponse): void {
    this.sendJson(res, {
      status: 'healthy',
      timestamp: Date.now(),
    });
  }

  /**
   * 发送 JSON 响应
   */
  private sendJson(res: http.ServerResponse, data: object): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * 发送错误响应
   */
  private sendError(res: http.ServerResponse, statusCode: number, message: string): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify({ error: message }));
  }
}
