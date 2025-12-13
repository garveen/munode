# Edge 间语音中转路由设计方案

## 版本信息
- **版本**: 1.1
- **日期**: 2025-12-13
- **状态**: 部分实现

## 最新更新 (v1.1 - 2025-12-13)

### 已实现功能
1. **UDP连接心跳机制** ✅
   - 10秒间隔心跳包（PING/PONG）
   - 30秒超时检测
   - 自动断开检测

2. **断开重连机制** ✅
   - 检测到超时自动发起重连
   - 最多5次重连尝试
   - 重连失败通知Hub仲裁

3. **认证和加密** ✅
   - 基于AES-128/256-CBC的加密
   - 每个包使用随机IV
   - 解密后内容信任机制

4. **Broadcast优化** ✅
   - 移除持久化缓存
   - 仅在单次broadcast中复用加密结果
   - 实时语音流不缓存

5. **路由表应用** ✅
   - VoiceRoutingManager管理路由表
   - 支持DIRECT/RELAY/FALLBACK三种路由模式
   - 被动网络质量探测

### Hub仲裁机制
当两个Edge之间双向重连都失败时：
1. Edge通过`edge.reconnectFailure`通知Hub
2. Hub收到双方通知后进行仲裁
3. Hub可以决定：
   - 强制一方断开连接
   - 重新分配路由
   - 或采取其他恢复措施

### 待实现功能
- [ ] Hub侧的仲裁逻辑实现
- [ ] TCP降级的完整实现（当前仅有框架）
- [ ] 中转节点负载均衡
- [ ] 完整的集成测试套件

## 一、当前架构分析

### 1.1 当前语音传输架构

MuNode 采用 Hub-Edge 分布式架构，Edge 节点之间通过 UDP 直连传输语音数据。

#### 架构拓扑
```
                    ┌──────────────────┐
                    │   Hub Server     │
                    │ (控制信道: WS)   │
                    └────────┬─────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
      ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
      │ Edge 1  │◄─────►│ Edge 2  │◄─────►│ Edge 3  │
      │  UDP    │  UDP  │  UDP    │  UDP  │  UDP    │
      └─────────┘       └─────────┘       └─────────┘
```

#### 核心组件

1. **VoiceUDPTransport** (`packages/protocol/src/voice/voice-udp-transport.ts`)
   - 管理 Edge 间的 UDP 语音传输
   - 维护远程 Edge 端点映射 (`remoteEndpoints: Map<edgeId, {host, port}>`)
   - 提供 `sendToEdge(edgeId, packet)` 发送到特定 Edge
   - 提供 `broadcast(packet, excludeEdge)` 广播到所有 Edge

2. **VoiceRouter** (`packages/edge-server/src/voice/voice-router.ts`)
   - 处理本地客户端的语音路由
   - 根据语音目标类型（PTT/Whisper）计算接收者
   - 触发 `broadcastVoicePacket` 事件供跨 Edge 转发

3. **VoiceManager** (`packages/edge-server/src/managers/voice-manager.ts`)
   - 监听 VoiceRouter 的 `broadcastVoicePacket` 事件
   - 调用 VoiceUDPTransport 将语音包转发到其他 Edge
   - 接收来自其他 Edge 的语音包并路由到本地客户端

#### 语音转发流程

```
Client A (Edge 1)  →  Edge 1 VoiceRouter
                          ↓
                      计算本地接收者 + 触发广播事件
                          ↓
                      VoiceManager
                          ↓
                      VoiceUDPTransport (Edge 1)
                          ↓
         ┌────────────────┴────────────────┐
         ↓                                  ↓
    Edge 2 UDP                         Edge 3 UDP
         ↓                                  ↓
    VoiceUDPTransport                  VoiceUDPTransport
         ↓                                  ↓
    VoiceManager                       VoiceManager
         ↓                                  ↓
    VoiceRouter                        VoiceRouter
         ↓                                  ↓
    计算本地接收者                      计算本地接收者
         ↓                                  ↓
    Client B                           Client C
```

### 1.2 当前架构的问题

**直连模式的局限性**：
- Edge 间采用全连接模式 (Full Mesh)，每个 Edge 需要与其他所有 Edge 建立直连
- 当两个 Edge 之间网络质量差（高延迟、丢包、防火墙阻断）时，语音质量下降或无法传输
- 无中转机制，无法利用网络质量更好的 Edge 进行中继

**典型场景**：
```
Edge CN (中国) ←──X──→ Edge US (美国)
      ↓                    ↓
   200ms 延迟          50ms 延迟
      ↓                    ↓
Edge HK (香港) ←───✓───→ Edge US
```
- CN-US 直连：高延迟 (300ms+) 或被阻断
- CN-HK 直连：低延迟 (50ms)
- HK-US 直连：低延迟 (150ms)
- **理想路径**: CN → HK → US (总延迟 200ms)

---

## 二、设计目标

### 2.1 核心目标

1. **智能路由**：自动选择最佳路径（直连 or 中转）
2. **动态切换**：检测到直连质量下降时自动切换到中转路由
3. **最小延迟**：选择延迟最小的中转路径
4. **负载均衡**：避免单一 Edge 成为瓶颈
5. **向下兼容**：不影响现有直连模式，渐进式启用

### 2.2 非目标

- ❌ 不实现复杂的多跳路由（最多 1 次中转）
- ❌ 不保证 100% 可靠传输（UDP 本质允许丢包）
- ❌ 不改变 Mumble 协议或客户端交互方式

---

## 三、架构设计

### 3.1 整体架构

#### 新增组件

```
┌─────────────────────────────────────────────────────────┐
│                       Hub Server                         │
│  - 收集 Edge 间网络质量指标 (RTT, 丢包率)               │
│  - 计算最优路由表                                       │
│  - 下发路由策略到各 Edge                                │
└─────────────────────────────────────────────────────────┘
                          ↓ (路由表推送)
              ┌───────────┼───────────┐
              ↓           ↓           ↓
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Edge 1  │ │  Edge 2  │ │  Edge 3  │
        │          │ │          │ │          │
        │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │
        │ │ 路由 │ │ │ │ 路由 │ │ │ │ 路由 │ │
        │ │ 管理 │ │ │ │ 管理 │ │ │ │ 管理 │ │
        │ │ 器   │ │ │ │ 器   │ │ │ │ 器   │ │
        │ └──────┘ │ │ └──────┘ │ │ └──────┘ │
        └──────────┘ └──────────┘ └──────────┘
```

#### 路由决策层次

**重要说明**：路由功能采用 **Hub 集中控制** 架构

1. **Hub 全局控制**（最高优先级）
   - Hub 配置的 `voiceRouting.enabled` 决定整个集群是否启用路由功能
   - Edge 启动时从 Hub 接收路由配置
   - Edge 无法自行决定是否启用，必须遵循 Hub 指令

2. **Hub 全局优化**（定期更新）
   - 收集全局网络拓扑
   - 计算最优路由表
   - 推送到各 Edge

3. **Edge 本地决策**（实时调整）
   - 基于实时网络质量指标
   - 在 Hub 路由表基础上动态选择直连或中转
   - 上报质量数据供 Hub 优化

**配置推送流程**：
```
Hub 启动 → 读取 voiceRouting 配置
    ↓
Edge 连接 → Hub 推送配置到 Edge
    ↓
Edge 接收 → enabled=true? 启动路由管理器 : 禁用路由
    ↓
运行中 → Hub 可随时推送配置更新（热更新）
```

### 3.2 Hub UDP 中转功能移除

**重要变更**：**完全移除** Hub 的 UDP 语音中转功能

**背景**：
- 现有架构中，Hub 可能参与 UDP 语音包的中转
- 新设计中，**Hub 完全不参与任何 UDP 语音包转发**
- 中转功能完全由 Edge 节点负责，Hub 仅负责控制和 TCP 降级

**移除内容**：
1. **移除 UDP 中转**：Hub 不再转发任何 UDP 语音包
2. **保留 TCP 降级**：Hub 的 WebSocket 控制信道仅用于 TCP 降级中转
3. **配置调整**：
   ```javascript
   hubRelay: {
     enableUdpRelay: false,          // 完全移除 UDP 中转
     enableTcpFallback: true,        // 仅保留 TCP 降级
     tcpRelayPriority: 'last'        // 作为最后手段
   }
   ```

**架构影响**：
- ✅ **降低 Hub 负载**：Hub 不再处理语音数据流
- ✅ **简化架构**：Hub = 纯控制节点，Edge = 数据转发节点
- ✅ **提升可扩展性**：Hub 负载不再随语音流量增长
- ⚠️ **依赖要求**：Edge 间必须有可用的 UDP 路径（直连或 Edge 中转），否则只能降级到 TCP

**路由模式更新**：

#### 模式 1: 直连模式 (Direct)
```
Edge A ───────UDP───────→ Edge B
```
- 两个 Edge 间网络质量良好
- RTT < 配置的阈值（如 200ms）
- 丢包率 < 配置的阈值（如 5%）

#### 模式 2: 中转模式 (Relay)
```
Edge A ───UDP───→ Edge C ───UDP───→ Edge B
```
- Edge A 到 Edge B 直连质量差
- Edge C 作为中转节点（**非 Hub**）
- A→C 和 C→B 的总延迟 < A→B 直连延迟

#### 模式 3: TCP 降级模式 (TCP Fallback)
```
Edge A ───TCP (via Hub WebSocket)───→ Edge B
```
- **所有 UDP 路径都不可用**（包括直连和 Edge 中转）
- 通过 Hub 的 WebSocket 控制信道中转
- **牺牲延迟保证连通性**

#### 模式 1: 直连模式 (Direct)

```
Edge A ───────UDP───────→ Edge B
```
- 两个 Edge 间网络质量良好
- RTT < 配置的阈值（如 200ms）
- 丢包率 < 配置的阈值（如 5%）

#### 模式 2: 中转模式 (Relay)

```
Edge A ───UDP───→ Edge C ───UDP───→ Edge B
```
- Edge A 到 Edge B 直连质量差
- Edge C 作为中转节点
- A→C 和 C→B 的总延迟 < A→B 直连延迟

#### 模式 3: 降级模式 (Fallback)

```
Edge A ───TCP (via Hub)───→ Edge B
```
- 所有 UDP 路径不可用
- 通过 Hub 的 WebSocket 控制信道中转
- 牺牲延迟保证连通性

---

## 四、数据结构设计

### 4.1 Edge 端数据结构

#### 网络质量指标

```typescript
/**
 * Edge 间连接质量指标
 */
interface EdgeConnectionQuality {
  targetEdgeId: number;        // 目标 Edge ID
  rtt: number;                 // 往返时延 (ms)
  packetLoss: number;          // 丢包率 (0-1)
  jitter: number;              // 抖动 (ms)
  bandwidth: number;           // 可用带宽估计 (kbps)
  lastUpdate: number;          // 最后更新时间戳
  sampleCount: number;         // 采样次数
}

/**
 * 连接质量存储
 */
class ConnectionQualityStore {
  private qualities: Map<number, EdgeConnectionQuality> = new Map();
  
  updateQuality(edgeId: number, metrics: Partial<EdgeConnectionQuality>): void;
  getQuality(edgeId: number): EdgeConnectionQuality | undefined;
  getAllQualities(): Map<number, EdgeConnectionQuality>;
}
```

#### 路由表

```typescript
/**
 * 路由条目类型
 */
enum RouteType {
  DIRECT = 'direct',      // 直连
  RELAY = 'relay',        // 中转
  FALLBACK = 'fallback'   // 降级 (TCP)
}

/**
 * 路由条目
 */
interface RouteEntry {
  targetEdgeId: number;      // 目标 Edge ID
  type: RouteType;           // 路由类型
  nextHop?: number;          // 下一跳 Edge ID (中转模式)
  cost: number;              // 路径成本（延迟 + 丢包惩罚）
  timestamp: number;         // 路由更新时间
  source: 'local' | 'hub';   // 路由来源
}

/**
 * 路由表
 */
class VoiceRoutingTable {
  private routes: Map<number, RouteEntry> = new Map();
  
  setRoute(edgeId: number, route: RouteEntry): void;
  getRoute(edgeId: number): RouteEntry | undefined;
  
  /**
   * 根据网络质量自动选择最佳路由
   */
  selectBestRoute(
    targetEdgeId: number,
    directQuality: EdgeConnectionQuality | undefined,
    relayQualities: Map<number, { via: EdgeConnectionQuality; toTarget: EdgeConnectionQuality }>
  ): RouteEntry;
}
```

#### 中转统计

```typescript
/**
 * 中转统计信息
 */
interface RelayStats {
  edgeId: number;              // 当前 Edge ID
  relayedPackets: number;      // 中转的包数量
  relayedBytes: number;        // 中转的字节数
  relayLoad: number;           // 中转负载 (0-1)
  maxRelayCapacity: number;    // 最大中转容量 (packets/s)
  
  // 每个中转路径的统计
  relayPaths: Map<string, {    // key: "srcEdge->dstEdge"
    packetCount: number;
    bytesCount: number;
    lastActive: number;
  }>;
}
```

### 4.2 Hub 端数据结构

#### 全局网络拓扑

```typescript
/**
 * Edge 间连接信息
 */
interface EdgeLink {
  sourceEdgeId: number;
  targetEdgeId: number;
  quality: EdgeConnectionQuality;
  bidirectional: boolean;      // 是否双向测量
}

/**
 * 全局网络拓扑
 */
class NetworkTopology {
  private edges: Set<number> = new Set();
  private links: Map<string, EdgeLink> = new Map(); // key: "src->dst"
  
  addEdge(edgeId: number): void;
  removeEdge(edgeId: number): void;
  updateLink(link: EdgeLink): void;
  
  /**
   * 计算 Edge A 到 Edge B 的最优路径
   * 使用 Dijkstra 算法，成本函数 = RTT + 丢包惩罚
   */
  findBestPath(sourceEdgeId: number, targetEdgeId: number): {
    path: number[];           // Edge ID 序列
    totalCost: number;        // 总成本
    hops: number;             // 跳数
  } | null;
  
  /**
   * 为所有 Edge 对计算路由表
   */
  computeGlobalRoutingTable(): Map<number, Map<number, RouteEntry>>;
}
```

#### 路由优化配置

```typescript
/**
 * 路由优化策略配置
 */
interface RoutingPolicy {
  // 直连阈值
  directRttThreshold: number;        // 直连 RTT 上限 (ms), 默认 200
  directLossThreshold: number;       // 直连丢包率上限, 默认 0.05
  
  // 中转条件
  enableRelay: boolean;              // 是否启用中转, 默认 true
  maxRelayHops: number;              // 最大中转跳数, 默认 1
  relayCostFactor: number;           // 中转成本因子, 默认 1.2 (比直连高 20%)
  
  // 路由切换
  routeSwitchHysteresis: number;     // 切换滞后时间 (ms), 默认 5000
  routeSwitchCostDelta: number;      // 切换成本差异阈值, 默认 0.3 (30%)
  
  // 负载均衡
  maxRelayLoadPerEdge: number;       // 单 Edge 最大中转负载, 默认 0.7
  preferredRelayEdges?: number[];    // 优选中转节点
  
  // 质量探测
  probeInterval: number;             // 探测间隔 (ms), 默认 10000
  probeTimeout: number;              // 探测超时 (ms), 默认 5000
  
  // 路由表更新
  routeTableUpdateInterval: number;  // Hub 推送路由表间隔 (ms), 默认 30000
}
```

---

## 五、配置架构设计

### 5.1 Hub 配置 (`config/hub.example.js`)

```javascript
module.exports = {
  // ... 现有配置 ...
  
  /**
   * 语音路由优化配置（全局开关）
   * 
   * 重要：Hub 启动时会将此配置推送给所有 Edge
   * Edge 无法单独启用，必须由 Hub 统一控制
   */
  voiceRouting: {
    // 全局功能开关（必须项）
    enabled: true,                    // 启用 Edge 间中转路由功能
    
    // 路由策略
    policy: {
      directRttThreshold: 200,        // 直连 RTT 阈值 (ms)
      directLossThreshold: 0.05,      // 直连丢包率阈值
      maxRelayHops: 1,                // 最大中转跳数
      relayCostFactor: 1.2,           // 中转成本因子
      routeSwitchHysteresis: 5000,    // 路由切换滞后 (ms)
      routeSwitchCostDelta: 0.3,      // 切换成本差异阈值
      maxRelayLoadPerEdge: 0.7,       // 单 Edge 最大中转负载
      probeInterval: 10000,           // 网络质量探测间隔 (ms)
      routeTableUpdateInterval: 30000 // 路由表推送间隔 (ms)
    },
    
    // 优选中转节点（可选，留空则自动选择）
    preferredRelayEdges: [
      // 2, // Edge 2 作为优选中转节点
    ],
    
    // Hub 自身中转配置
    hubRelay: {
      enableUdpRelay: false,          // 完全移除 Hub 的 UDP 中转功能
      enableTcpFallback: true,        // 仅保留 TCP 降级功能（通过 WebSocket）
      tcpRelayPriority: 'last'        // TCP 中转作为最后手段
    },
    
    // 路由优化调试
    debug: {
      logRouteChanges: true,          // 记录路由变化
      logQualityMetrics: false,       // 记录质量指标
      logRelayStats: true             // 记录中转统计
    }
  }
};
```

### 5.2 Edge 配置 (`config/edge.example.js`)

```javascript
module.exports = {
  // ... 现有配置 ...
  
  /**
   * 语音路由配置
   * 
   * 注意：本配置为 Edge 本地设置，但功能启用受 Hub 控制
   * 如果 Hub 未启用 voiceRouting，Edge 的配置将被忽略
   */
  voiceRouting: {
    // 注意：此字段会被 Hub 推送的配置覆盖
    // enabled: true,  // 由 Hub 控制，Edge 无需配置
    // 本地路由决策
    localDecision: {
      enabled: true,                  // 启用本地决策
      updateInterval: 5000,           // 本地路由更新间隔 (ms)
      qualityCheckInterval: 10000,    // 质量检查间隔 (ms)
      
      // 本地阈值（可覆盖 Hub 全局配置）
      directRttThreshold: 200,
      directLossThreshold: 0.05
    },
    
    // 中转功能
    relay: {
      enabled: true,                  // 允许作为中转节点
      
      // 容量限制（分别限制 CPU 和带宽）
      maxRelayCpuLoad: 0.7,           // CPU 上限 70%
      maxRelayBandwidth: 10000,       // 带宽上限 10 Mbps (kbps)
      
      // 静态阈值（不动态调整）
      softLimitThreshold: 0.7,        // 软限制：向 Hub 报告"接近满载"
      hardLimitThreshold: 0.9,        // 硬限制：拒绝新中转请求
      recoveryThreshold: 0.6,         // 恢复阈值：负载低于此值恢复正常
      
      priority: 1                      // 中转优先级 (1-10, 越高越优先)
    },
    
    // 网络质量探测（完全被动）
    probe: {
      enabled: true,
      method: 'passive',              // 被动探测：利用实际语音包测量
      updateInterval: 10000,          // 质量指标更新间隔 (ms)
      
      // 丢包率统计窗口
      lossWindowSize: 100,            // 统计最近 100 个包的丢包率
      
      // RTT 平滑参数（指数移动平均）
      rttSmoothFactor: 0.2,           // 新样本权重 20%
      
      // 质量指标过期时间
      metricsTTL: 30000               // 30 秒无流量则指标过期
    },
    
    // 降级策略
    fallback: {
      enableTcpFallback: true,        // 启用 TCP 降级
      tcpFallbackDelay: 10000,        // 切换到 TCP 的延迟 (ms)
      udpRecoveryCheckInterval: 30000 // UDP 恢复检查间隔 (ms)
    }
  }
};
```

---

## 六、代码架构设计

### 6.1 新增模块

#### 6.1.1 VoiceRoutingManager (Edge)

**位置**: `packages/edge-server/src/voice/voice-routing-manager.ts`

```typescript
import { EventEmitter } from 'events';
import { EdgeConfig, RouteEntry, EdgeConnectionQuality } from '../types.js';

/**
 * 语音路由管理器
 * 
 * 职责:
 * - 维护到其他 Edge 的路由表
 * - 收集网络质量指标
 * - 执行本地路由决策
 * - 处理来自 Hub 的路由表更新
 */
export class VoiceRoutingManager extends EventEmitter {
  private config: EdgeConfig;
  private logger: Logger;
  
  // 路由表
  private routingTable: Map<number, RouteEntry> = new Map();
  
  // 网络质量
  private connectionQualities: Map<number, EdgeConnectionQuality> = new Map();
  
  // 中转统计
  private relayStats: RelayStats;
  
  constructor(config: EdgeConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.relayStats = this.initRelayStats();
  }
  
  /**
   * 启动路由管理器
   */
  async start(): Promise<void> {
    // 启动网络质量探测
    this.startQualityProbe();
    
    // 启动本地路由更新
    this.startLocalRouteUpdate();
    
    // 监听 Hub 路由表推送
    this.listenToHubRouteUpdates();
  }
  
  /**
   * 获取到目标 Edge 的路由
   */
  getRoute(targetEdgeId: number): RouteEntry | undefined {
    return this.routingTable.get(targetEdgeId);
  }
  
  /**
   * 更新网络质量指标
   */
  updateQuality(targetEdgeId: number, metrics: Partial<EdgeConnectionQuality>): void {
    const existing = this.connectionQualities.get(targetEdgeId);
    const updated = { ...existing, ...metrics, lastUpdate: Date.now() };
    this.connectionQualities.set(targetEdgeId, updated as EdgeConnectionQuality);
    
    // 触发本地路由重新计算
    this.emit('quality-updated', targetEdgeId, updated);
  }
  
  /**
   * 执行本地路由决策
   */
  private performLocalRouteDecision(targetEdgeId: number): RouteEntry | null {
    const directQuality = this.connectionQualities.get(targetEdgeId);
    
    // 检查直连是否满足条件
    if (this.isDirectRouteFeasible(directQuality)) {
      return {
        targetEdgeId,
        type: RouteType.DIRECT,
        cost: this.calculateDirectCost(directQuality!),
        timestamp: Date.now(),
        source: 'local'
      };
    }
    
    // 寻找中转路径
    const relayRoute = this.findBestRelayRoute(targetEdgeId);
    if (relayRoute) {
      return relayRoute;
    }
    
    // 降级到 TCP
    if (this.config.voiceRouting.fallback.enableTcpFallback) {
      return {
        targetEdgeId,
        type: RouteType.FALLBACK,
        cost: 999,
        timestamp: Date.now(),
        source: 'local'
      };
    }
    
    return null;
  }
  
  /**
   * 判断直连路由是否可行
   */
  private isDirectRouteFeasible(quality: EdgeConnectionQuality | undefined): boolean {
    if (!quality) return false;
    
    const config = this.config.voiceRouting.localDecision;
    return (
      quality.rtt < config.directRttThreshold &&
      quality.packetLoss < config.directLossThreshold
    );
  }
  
  /**
   * 寻找最佳中转路由
   */
  private findBestRelayRoute(targetEdgeId: number): RouteEntry | null {
    // 遍历所有可能的中转节点
    let bestRoute: RouteEntry | null = null;
    let bestCost = Infinity;
    
    for (const [relayEdgeId, toRelayQuality] of this.connectionQualities) {
      if (relayEdgeId === targetEdgeId) continue;
      
      const relayToTargetQuality = this.getRelayToTargetQuality(relayEdgeId, targetEdgeId);
      if (!relayToTargetQuality) continue;
      
      // 计算中转成本 = 本地→中转 + 中转→目标
      const cost = this.calculateRelayCost(toRelayQuality, relayToTargetQuality);
      
      if (cost < bestCost) {
        bestCost = cost;
        bestRoute = {
          targetEdgeId,
          type: RouteType.RELAY,
          nextHop: relayEdgeId,
          cost,
          timestamp: Date.now(),
          source: 'local'
        };
      }
    }
    
    return bestRoute;
  }
  
  /**
   * 网络质量探测
   */
  private startQualityProbe(): void {
    const interval = this.config.voiceRouting.probe.interval;
    
    setInterval(() => {
      this.probeAllEdges();
    }, interval);
  }
  
  /**
   * 探测所有 Edge 的网络质量
   */
  private async probeAllEdges(): Promise<void> {
    const edges = this.getAllEdgeIds();
    
    for (const edgeId of edges) {
      try {
        const metrics = await this.probeEdge(edgeId);
        this.updateQuality(edgeId, metrics);
      } catch (error) {
        this.logger.error(`Failed to probe edge ${edgeId}:`, error);
      }
    }
  }
  
  /**
   * 探测单个 Edge
   */
  private async probeEdge(edgeId: number): Promise<Partial<EdgeConnectionQuality>> {
    // 发送 UDP 探测包，测量 RTT 和丢包率
    // 实现类似 ICMP ping 的机制
    // 返回测量结果
    throw new Error('Not implemented');
  }
  
  /**
   * 处理中转请求
   */
  handleRelayPacket(packet: VoicePacketHeader, voiceData: Buffer, fromEdgeId: number): void {
    // 检查是否允许中转
    if (!this.config.voiceRouting.relay.enabled) {
      this.logger.warn(`Relay disabled, dropping packet from edge ${fromEdgeId}`);
      return;
    }
    
    // 检查中转负载
    if (this.relayStats.relayLoad > this.config.voiceRouting.relay.maxRelayLoad) {
      this.logger.warn(`Relay overloaded, dropping packet from edge ${fromEdgeId}`);
      return;
    }
    
    // 获取目标路由
    const route = this.getRoute(packet.targetId);
    if (!route) {
      this.logger.warn(`No route to edge ${packet.targetId}, dropping relay packet`);
      return;
    }
    
    // 转发到下一跳
    this.forwardRelayPacket(packet, voiceData, route);
    
    // 更新中转统计
    this.updateRelayStats(fromEdgeId, packet.targetId, voiceData.length);
  }
  
  /**
   * 转发中转包
   */
  private forwardRelayPacket(packet: VoicePacketHeader, voiceData: Buffer, route: RouteEntry): void {
    // 通过 VoiceUDPTransport 转发
    this.emit('forward-relay', packet, voiceData, route);
  }
}
```

#### 6.1.2 NetworkTopologyManager (Hub)

**位置**: `packages/hub-server/src/routing/network-topology-manager.ts`

```typescript
/**
 * 网络拓扑管理器
 * 
 * 职责:
 * - 收集所有 Edge 的网络质量报告
 * - 构建全局网络拓扑
 * - 计算最优路由表
 * - 下发路由表到各 Edge
 */
export class NetworkTopologyManager {
  private logger: Logger;
  private config: HubConfig;
  
  private topology: NetworkTopology;
  private routingPolicy: RoutingPolicy;
  
  constructor(config: HubConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.topology = new NetworkTopology();
    this.routingPolicy = config.voiceRouting.policy;
  }
  
  /**
   * 启动拓扑管理器
   */
  async start(): Promise<void> {
    // 启动路由表计算和推送
    this.startRouteTableUpdates();
    
    // 监听 Edge 的质量报告
    this.listenToQualityReports();
  }
  
  /**
   * 处理 Edge 的网络质量报告
   */
  handleQualityReport(edgeId: number, report: EdgeConnectionQuality[]): void {
    for (const quality of report) {
      this.topology.updateLink({
        sourceEdgeId: edgeId,
        targetEdgeId: quality.targetEdgeId,
        quality,
        bidirectional: false
      });
    }
    
    this.logger.debug(`Updated topology from edge ${edgeId}, ${report.length} links`);
  }
  
  /**
   * 计算并推送路由表
   */
  private async computeAndPushRoutes(): Promise<void> {
    const globalRoutes = this.topology.computeGlobalRoutingTable();
    
    // 推送到各 Edge
    for (const [edgeId, routes] of globalRoutes) {
      await this.pushRoutesToEdge(edgeId, routes);
    }
    
    this.logger.info(`Pushed routing tables to ${globalRoutes.size} edges`);
  }
  
  /**
   * 推送路由表到 Edge
   */
  private async pushRoutesToEdge(edgeId: number, routes: Map<number, RouteEntry>): Promise<void> {
    // 通过控制信道发送路由表
    const message = {
      type: 'route-table-update',
      routes: Array.from(routes.entries())
    };
    
    // 发送到 Edge
    this.emit('push-routes', edgeId, message);
  }
  
  /**
   * 定期更新路由表
   */
  private startRouteTableUpdates(): void {
    const interval = this.routingPolicy.routeTableUpdateInterval;
    
    setInterval(() => {
      this.computeAndPushRoutes();
    }, interval);
  }
}
```

### 6.2 修改现有模块

#### 6.2.1 VoiceUDPTransport 增强

**位置**: `packages/protocol/src/voice/voice-udp-transport.ts`

```typescript
// 在现有 VoiceUDPTransport 类中添加方法

/**
 * 通过中转发送语音包
 * 
 * @param relayEdgeId 中转节点 Edge ID
 * @param finalTargetEdgeId 最终目标 Edge ID
 * @param packet 语音包头
 * @param voiceData 语音数据
 */
sendViaRelay(
  relayEdgeId: number,
  finalTargetEdgeId: number,
  packet: VoicePacketHeader,
  voiceData: Buffer
): void {
  // 修改包头，添加中转信息
  const relayPacket: VoicePacketHeader = {
    ...packet,
    targetId: finalTargetEdgeId,  // 保留最终目标
    // 可选：添加自定义字段标识这是中转包
  };
  
  // 发送到中转节点
  this.sendToEdge(relayEdgeId, relayPacket, voiceData);
  
  console.debug(
    `Sent voice packet via relay: ` +
    `sender=${packet.senderId}, relay=${relayEdgeId}, target=${finalTargetEdgeId}`
  );
}

/**
 * 处理收到的中转包
 */
private handleRelayPacket(packet: VoicePacketHeader, voiceData: Buffer, fromEdgeId: number): void {
  // 检查是否是发给本 Edge 的中转包
  const isFinalDestination = packet.targetId === this.config.server_id;
  
  if (isFinalDestination) {
    // 本 Edge 是最终目的地，正常处理
    this.emit('voice-packet', { header: packet, voiceData }, null);
  } else {
    // 需要继续转发
    this.emit('relay-request', packet, voiceData, fromEdgeId);
  }
}
```

#### 6.2.2 VoiceManager 集成路由管理器

**位置**: `packages/edge-server/src/managers/voice-manager.ts`

```typescript
import { VoiceRoutingManager } from '../voice/voice-routing-manager.js';

export class VoiceManager {
  // ... 现有字段 ...
  private routingManager?: VoiceRoutingManager;
  
  constructor(config: EdgeConfig, handlerFactory: HandlerFactory, voiceTransport?: VoiceUDPTransport) {
    this.config = config;
    this.handlerFactory = handlerFactory;
    this.voiceTransport = voiceTransport;
    
    // 初始化路由管理器
    if (config.voiceRouting?.localDecision?.enabled) {
      this.routingManager = new VoiceRoutingManager(config, logger);
    }
  }
  
  setupVoiceTransportHandlers(): void {
    // ... 现有代码 ...
    
    // 集成路由管理器
    if (this.routingManager) {
      this.setupRoutingManager();
    }
  }
  
  private setupRoutingManager(): void {
    // 监听路由管理器的转发请求
    this.routingManager!.on('forward-relay', (packet, voiceData, route) => {
      if (route.type === RouteType.RELAY && route.nextHop) {
        this.voiceTransport!.sendViaRelay(route.nextHop, route.targetEdgeId, packet, voiceData);
      }
    });
    
    // 监听中转请求
    this.voiceTransport!.on('relay-request', (packet, voiceData, fromEdgeId) => {
      this.routingManager!.handleRelayPacket(packet, voiceData, fromEdgeId);
    });
    
    // 启动路由管理器
    this.routingManager!.start();
  }
  
  // 修改现有的广播逻辑，使用路由管理器
  private async broadcastVoiceToEdges(broadcast: VoiceBroadcast): Promise<void> {
    const allEdges = this.handlerFactory.stateManager.getAllEdges();
    
    for (const edgeId of allEdges) {
      if (edgeId === this.config.server_id) continue;
      
      // 获取路由
      const route = this.routingManager?.getRoute(edgeId);
      
      if (!route) {
        logger.warn(`No route to edge ${edgeId}, skipping`);
        continue;
      }
      
      // 根据路由类型发送
      switch (route.type) {
        case RouteType.DIRECT:
          this.voiceTransport!.sendToEdge(edgeId, voicePacket, broadcast.packet);
          break;
          
        case RouteType.RELAY:
          this.voiceTransport!.sendViaRelay(route.nextHop!, edgeId, voicePacket, broadcast.packet);
          break;
          
        case RouteType.FALLBACK:
          // 通过 TCP 发送
          await this.sendVoiceViaTcp(edgeId, broadcast);
          break;
      }
    }
  }
}
```

---

## 七、实施路线图

### Phase 0: Hub 全局控制机制 (3 天)

**目标**: 建立 Hub 统一管控 Edge 路由功能的基础

1. **Hub 配置推送机制** (1 天)
   - [ ] Hub 启动时读取 `voiceRouting` 配置
   - [ ] Edge 连接时通过控制信道推送配置
   - [ ] Edge 接收并应用 Hub 推送的配置

2. **完全移除 Hub UDP 中转** (1 天)
   - [ ] 修改 Hub 代码，**完全移除**现有的 UDP 语音中转逻辑
   - [ ] 确保 Hub 不再监听或转发任何 UDP 语音包
   - [ ] 更新 Hub 配置：`enableUdpRelay: false`

3. **功能开关验证** (1 天)
   - [ ] 测试 Hub 配置 `enabled: false` 时，Edge 不启用路由
   - [ ] 测试 Hub 配置 `enabled: true` 时，Edge 正常工作
   - [ ] 测试配置热更新（运行时切换）

**配置推送协议**：
```javascript
// Hub 启动时或 Edge 连接时发送
{
  type: 'voice-routing-config',
  config: {
    enabled: true,              // 全局开关
    policy: { ... },            // 路由策略
    preferredRelayEdges: [...]  // 优选中转节点
  },
  timestamp: Date.now()
}

// Edge 接收后应用
onReceiveConfig(config) {
  if (!config.enabled) {
    this.routingManager?.disable();
    return;
  }
  this.routingManager?.applyConfig(config);
}
```

---

### Phase 1: 基础设施 (2 周)

**目标**: 建立网络质量监控和路由表管理基础

1. **数据结构定义** (2 天)
   - [ ] 定义 `EdgeConnectionQuality`, `RouteEntry`, `RelayStats` 等类型
   - [ ] 更新 `EdgeConfig` 和 `HubConfig` 配置接口

2. **被动网络质量探测** (3 天)
   - [ ] 实现从语音包中提取时间戳和序列号
   - [ ] 计算 RTT（基于时间戳差）
   - [ ] 统计丢包率（基于序列号间隙）
   - [ ] 定期上报质量指标到 Hub

3. **路由表管理** (5 天)
   - [ ] 实现 `VoiceRoutingManager` (Edge)
   - [ ] 实现 `NetworkTopologyManager` (Hub)
   - [ ] Hub 计算和推送路由表

4. **配置框架** (2 天)
   - [ ] 添加路由配置到示例配置文件
   - [ ] 实现配置验证和默认值

### Phase 2: 中转路由 (2 周)

**目标**: 实现基本的中转路由功能

1. **VoiceUDPTransport 增强** (3 天)
   - [ ] 添加 `sendViaRelay()` 方法
   - [ ] 实现中转包识别和转发
   - [ ] 添加中转统计

2. **路由决策** (4 天)
   - [ ] 实现本地路由决策算法
   - [ ] 实现路由切换滞后机制
   - [ ] 处理 Hub 路由表更新

3. **集成 VoiceManager** (3 天)
   - [ ] 修改广播逻辑使用路由管理器
   - [ ] 处理中转请求
   - [ ] 测试端到端中转流程

4. **中转负载管理** (2 天)
   - [ ] 实现中转负载监控
   - [ ] 实现过载保护
   - [ ] 优化中转节点选择

### Phase 3: 降级和优化 (1 周)

**目标**: 完善降级机制和性能优化

1. **TCP 降级** (2 天)
   - [ ] 实现通过 Hub WebSocket 转发语音
   - [ ] 自动切换到 TCP 降级
   - [ ] UDP 恢复检测

2. **性能优化** (3 天)
   - [ ] 路由查找缓存
   - [ ] 中转包快速路径
   - [ ] 减少 CPU 和内存开销

3. **监控和调试** (2 天)
   - [ ] 添加详细日志
   - [ ] 暴露路由和中转指标
   - [ ] 实现调试命令

### Phase 4: 测试和部署 (1 周)

1. **单元测试** (2 天)
   - [ ] 测试路由决策算法
   - [ ] 测试中转转发逻辑
   - [ ] 测试降级机制

2. **集成测试** (2 天)
   - [ ] 3 Edge 集群测试
   - [ ] 模拟网络故障
   - [ ] 压力测试

3. **文档和部署** (3 天)
   - [ ] 更新用户文档
   - [ ] 部署指南
   - [ ] 性能调优建议

---

## 八、测试策略

### 8.1 网络环境模拟

使用 Linux `tc` 工具模拟不同网络条件：

```bash
# 模拟高延迟
tc qdisc add dev eth0 root netem delay 200ms

# 模拟丢包
tc qdisc add dev eth0 root netem loss 10%

# 模拟带宽限制
tc qdisc add dev eth0 root tbf rate 1mbit burst 32kbit latency 400ms

# 清除配置
tc qdisc del dev eth0 root
```

### 8.2 测试场景

#### 场景 1: 直连正常

```
Edge A ───(50ms, 0%)───→ Edge B
```
- **期望**: 使用直连模式
- **验证**: 检查路由表，确认 type=DIRECT

#### 场景 2: 直连质量差，存在中转

```
Edge A ───(300ms, 10%)───→ Edge B
   ↓                          ↑
(50ms, 0%)              (80ms, 0%)
   ↓                          ↑
Edge C ────────────────────→
```
- **期望**: 使用 Edge C 作为中转
- **验证**: 检查路由表，确认 type=RELAY, nextHop=C

#### 场景 3: UDP 完全不可达

```
Edge A ───X (防火墙)───→ Edge B
```
- **期望**: 降级到 TCP (Hub 中转)
- **验证**: 检查路由表，确认 type=FALLBACK

#### 场景 4: 动态切换

```
初始: Edge A ──直连(50ms)──→ Edge B
网络变化: Edge A ──直连(300ms)──→ Edge B
中转可用: Edge A → Edge C(50ms) → Edge B(80ms)
```
- **期望**: 5 秒后切换到中转模式
- **验证**: 监控路由变化日志

### 8.3 性能基准

#### 延迟增加

- **直连**: 0ms (无额外开销)
- **1 跳中转**: 1-3ms (仅处理开销，包括路由查找、包解析、转发)
- **TCP 降级**: 10-30ms (序列化、TCP 传输、Hub 转发)

#### 吞吐量影响

假设单个语音包 100 bytes，20ms 间隔（50 pps）：

| 模式 | 每用户带宽 | 100 并发用户 | 1000 并发用户 |
|------|-----------|-------------|--------------|
| 直连 | 40 Kbps | 4 Mbps | 40 Mbps |
| 1 跳中转 | 40 Kbps | 8 Mbps* | 80 Mbps* |
| TCP 降级 | 50 Kbps** | 5 Mbps | 50 Mbps |

\* 中转节点需处理双倍流量（接收 + 转发）  
\** TCP 头部开销约 25%

#### CPU 开销（单核性能）

**每个语音包的处理时间**：

| 操作 | 直连模式 | 中转模式 | 增量 |
|------|---------|---------|------|
| 路由查找 | 0ms | 0.05ms | +0.05ms |
| 包解析 | 0.1ms | 0.1ms | 0ms |
| 路由决策 | 0ms | 0.02ms | +0.02ms |
| 中转转发 | - | 0.08ms | +0.08ms |
| **总计** | **0.1ms** | **0.25ms** | **+0.15ms** |

**并发容量**（假设 CPU 占用上限 50%）：

- 直连: ~5000 pps = 100 并发用户
- 中转: ~2000 pps = 40 并发用户（作为中转节点）
- 混合: 本地 80 用户 + 中转 20 用户流量

#### 内存开销

**每个 Edge 节点**：

| 数据结构 | 单项大小 | 数量（100 Edge） | 总计 |
|---------|---------|----------------|------|
| 路由表 | 80 bytes/entry | 100 | 8 KB |
| 质量指标 | 120 bytes/entry | 100 | 12 KB |
| 中转统计 | 200 bytes/path | 50（平均） | 10 KB |
| 探测缓存 | 50 bytes/sample | 500 | 25 KB |
| **总计** | - | - | **~55 KB** |

**Hub 端**（全局拓扑）：

| 数据结构 | 单项大小 | 数量（100 Edge） | 总计 |
|---------|---------|----------------|------|
| Edge 信息 | 100 bytes | 100 | 10 KB |
| 链路质量 | 150 bytes/link | 10,000（全连接） | 1.5 MB |
| 路由表 | 80 bytes/route | 10,000 | 800 KB |
| **总计** | - | - | **~2.3 MB** |

#### 网络开销

**网络质量探测**：

- 探测包大小: 64 bytes
- 探测频率: 每 10 秒
- 每个 Edge 对: 64 bytes × 2（往返） × 6 pps（60秒内）= ~770 bytes/分钟
- 100 Edge 集群: 100 × 99 × 770 / 2 ≈ 3.8 MB/分钟 ≈ 500 Kbps

**路由表推送**：

- 单次推送大小: ~10 KB（100 Edge 的路由表）
- 推送频率: 每 30 秒
- 带宽: 10 KB × 100 Edge / 30s ≈ 33 Kbps

**总额外网络开销**: ~533 Kbps（对于 100 Edge 集群）

#### 性能总结

**轻量级开销** ✅：
- 单个语音包增加 <0.15ms 延迟
- 内存增量 <100 KB/Edge
- 网络开销 <1% (相对语音流量)

**中转节点压力** ⚠️：
- CPU: 处理能力降低 ~60%（作为中转时）
- 带宽: 双倍流量（接收 + 转发）
- **建议**: 配置高性能 Edge 作为优选中转节点

**扩展性** ✅：
- 10 Edge: 几乎无感知
- 50 Edge: 轻微影响 (<5% 资源)
- 100 Edge: 可接受 (<10% 资源)
- 500+ Edge: 需分层架构（区域 Hub）

---

## 九、安全考虑

**设计前提**: 所有 Edge 节点均为可信节点，由同一运营主体部署和管理。

### 9.1 信任模型

- ✅ **Edge 互信**: 所有 Edge 属于同一集群，相互信任
- ✅ **简化设计**: 无需 Edge 间认证、加密、权限控制
- ✅ **性能优先**: 去除安全检查开销，优化转发性能

### 9.2 基本防护

虽然 Edge 可信，仍需基本的资源保护：

- **中转负载限制** (`maxRelayLoad`): 防止单个 Edge 过载
- **中转带宽限制** (`maxRelayBandwidth`): 保护网络资源
- **异常检测**: 监控异常流量模式，及时告警

### 9.3 安全建议

部署时的安全实践：

- Edge 节点部署在隔离的内部网络
- 使用 VPN/专线连接 Edge 节点
- 定期审计 Edge 节点配置和日志
- 客户端连接仍需 TLS 加密和认证

---

## 十、总结

### 10.1 核心优势

✅ **智能路由**: 自动选择最佳路径，提升语音质量  
✅ **高可用性**: 通过中转和降级保证连通性  
✅ **渐进式部署**: 向下兼容，可逐步启用  
✅ **灵活配置**: Hub 全局优化 + Edge 本地决策  
✅ **可观测性**: 丰富的指标和日志支持运维  

### 10.2 适用场景

- 跨国/跨地区部署，部分 Edge 间直连质量差
- 复杂网络环境，防火墙/NAT 限制
- 需要高可用性，单点故障不影响整体服务

### 10.3 不适用场景

- 所有 Edge 在同一内网，直连质量优秀
- 用户规模小 (< 100)，不需要复杂路由
- 对延迟极度敏感，无法接受中转开销

### 10.4 下一步行动

1. 评审本设计文档，确认技术方案
2. 启动 Phase 1 开发，建立基础设施
3. 小规模测试验证可行性
4. 根据反馈迭代优化

---

---

## 十一、未决问题清单

在开始实施前，需要明确以下问题：

### 11.1 路由策略

#### Q1: 路由切换策略
**问题**: 直连质量恶化到什么程度才切换到中转？切换是否有延迟要求？

**选项**：
- A. 激进切换：RTT > 150ms 或丢包 > 3% 立即切换
- B. 保守切换：RTT > 250ms 或丢包 > 8% 才切换
- C. 自适应：根据语音编码器容忍度动态调整

**影响**: 影响路由稳定性和切换频率

**建议**: 选 B（保守），避免频繁切换导致的音质抖动

---

#### Q2: 路由切换滞后时间
**问题**: 从检测到质量问题到实际切换路由，需要等待多久避免抖动？

**选项**：
- A. 立即切换（0 秒）
- B. 短滞后（3-5 秒）
- C. 长滞后（10-15 秒）

**影响**: 影响用户体验和网络抖动容忍度

**建议**: 选 B（3-5 秒），平衡响应速度和稳定性

---

#### Q3: 成本计算公式
**问题**: 如何量化路由成本？中转和直连的权重如何平衡？

**当前方案**:
```
直连成本 = RTT + (丢包率 × 1000)
中转成本 = (RTT_to_relay + RTT_relay_to_target) × 1.2 + (丢包率_总 × 1000)
```

**是否接受**？还是需要调整权重？

---

### 11.2 中转节点选择

#### Q4: 中转节点优先级
**问题**: 如何选择中转节点？是否有地理位置偏好？

**选项**：
- A. 自动选择：完全基于网络质量指标
- B. 手动指定：管理员配置优选中转节点（如香港、新加坡节点）
- C. 混合模式：优先使用指定节点，质量不佳时自动选择

**影响**: 影响路由稳定性和运维复杂度

**建议**: 选 C（混合），提供 `preferredRelayEdges` 配置

---

#### Q5: 中转节点容量限制 ✅
**问题**: 单个 Edge 作为中转节点能承载多少流量？

**已确认方案**:

**5.1 分别限制 CPU 和带宽**
```javascript
maxRelayCpuLoad: 0.7,       // 70% CPU 上限
maxRelayBandwidth: 10000,   // 10 Mbps 带宽上限
```

**5.2 使用静态阈值**
- 配置文件写死，不动态调整
- 简单可靠，易于调试

**5.3 超载时降低优先级**
- **软限制**（70%）：向 Hub 报告"接近满载"，Hub 优先选择其他中转节点
- **硬限制**（90%）：拒绝新的中转请求，保护已有连接
- **恢复机制**：负载降到 60% 以下时，恢复正常优先级

---

### 11.3 网络探测

#### Q6: 探测频率和方法 ✅
**问题**: 如何探测 Edge 间网络质量？频率如何设定？

**已确认方案**:

**6.1 探测频率：10 秒**
- 平衡准确性和开销
- 可配置化，默认 10000ms

**6.2 使用被动探测**
- **完全被动**：利用实际语音包测量网络质量
- **零额外开销**：无需发送专门的探测包
- **实时准确**：基于真实业务流量测量

**6.3 统一策略**
- 不区分空闲时和高峰时
- 简化实现，保持一致性

**被动探测实现原理**：
```javascript
// 从 VoiceUDPTransport 收到的语音包中提取信息
onVoicePacket(packet, fromEdgeId) {
  const sendTime = packet.timestamp;
  const recvTime = Date.now();
  const rtt = recvTime - sendTime;  // 单向延迟 × 2
  
  // 更新质量指标
  updateQuality(fromEdgeId, { rtt, lastUpdate: recvTime });
}

// 统计丢包率（基于序列号）
trackPacketLoss(fromEdgeId, sequence) {
  const expected = lastSequence[fromEdgeId] + 1;
  const loss = Math.max(0, sequence - expected);
  packetLoss[fromEdgeId] = loss / totalPackets;
}
```

---

#### Q7: 探测包大小 ✅
**问题**: 探测包应该多大？是否模拟实际语音包？

**已确认方案**:

**不需要此配置项**
- 因为使用完全被动探测，基于实际语音包测量
- 无需配置探测包大小
- 测量的就是真实流量的网络质量

---

### 11.4 降级策略

#### Q8: TCP 降级触发条件
**问题**: 什么情况下使用 TCP 降级？是否始终保持 TCP 通道？

**选项**：
- A. 主动保持：始终通过 Hub WebSocket 建立备用通道
- B. 被动建立：检测到所有 UDP 路径失败后才建立
- C. 禁用降级：仅使用 UDP，失败则静音

**影响**: 影响可靠性和资源消耗

**建议**: 选 A（主动保持），Hub WebSocket 已存在，无额外连接成本

---

#### Q9: TCP 降级恢复策略
**问题**: 使用 TCP 降级后，如何恢复到 UDP？

**当前方案**: 每 30 秒检查一次 UDP 是否恢复

**需要确认**：
- 检查间隔是否合适？
- 恢复条件：UDP 可用即切换 or 需要稳定一段时间？
- 是否需要通知用户切换状态？

---

### 11.5 Hub 职责

#### Q10: Hub 路由计算频率
**问题**: Hub 多久计算一次全局路由表？

**当前方案**: 每 30 秒

**需要确认**：
- 频率是否合适？（更高 = 更快响应拓扑变化，但更多 CPU）
- 是否需要事件驱动？（Edge 质量剧变时立即重算）
- 是否允许 Edge 覆盖 Hub 路由？（本地决策优先级）

---

#### Q11: Hub 是否参与中转？ ✅
**问题**: Hub 能否作为中转节点？还是仅负责控制？

**已确认方案**:

**Hub 完全不参与 UDP 中转**
- Hub 仅负责控制和 TCP 降级中转
- UDP 语音包的中转完全由 Edge 节点负责
- 保持职责分离：Hub=控制，Edge=数据转发

**TCP 降级中转**：
- 当所有 UDP 路径都不可用时，通过 Hub 的 WebSocket 控制信道中转
- 这不是常规中转，而是最后的降级手段
- 配置：`enableTcpFallback: true, tcpRelayPriority: 'last'`

---

### 11.6 监控和调试

#### Q12: 需要哪些监控指标？
**问题**: 运维时需要看到哪些关键指标？

**候选指标**：
- [ ] 每个 Edge 对的实时 RTT 和丢包率
- [ ] 当前使用的路由类型分布（直连/中转/降级）
- [ ] 中转节点的负载和流量
- [ ] 路由切换频率和原因
- [ ] TCP 降级的使用时长

**请选择**：哪些是必须的？哪些是可选的？

---

#### Q13: 调试工具需求
**问题**: 需要哪些调试命令或界面？

**候选功能**：
- [ ] 查看当前路由表：`edge route list`
- [ ] 查看网络质量：`edge quality show`
- [ ] 手动触发探测：`edge probe <target_edge>`
- [ ] 强制路由切换：`edge route set <target> <mode>`
- [ ] 导出路由日志：`edge route export`

**请选择**：哪些是优先级高的？

---

### 11.7 兼容性

#### Q14: 旧版本 Edge 兼容
**问题**: 如果集群中有旧版本 Edge（不支持中转），如何处理？

**选项**：
- A. 强制升级：所有 Edge 必须支持中转
- B. 优雅降级：新 Edge 可中转，旧 Edge 仅直连
- C. 版本协商：动态检测能力，按需启用

**影响**: 影响部署灵活性

**建议**: 选 B（优雅降级），通过特性标志（feature flag）控制

---

#### Q15: 客户端感知
**问题**: 客户端是否需要知道路由变化？是否影响客户端行为？

**选项**：
- A. 完全透明：客户端无感知，所有路由由服务端处理
- B. 状态通知：通知客户端当前连接质量（仅展示）
- C. 客户端参与：客户端可请求特定路由模式

**影响**: 影响客户端实现复杂度

**建议**: 选 A（完全透明），保持客户端简单

---

### 11.8 部署和运维

#### Q16: 分阶段部署策略
**问题**: 如何在生产环境中安全部署此功能？

**候选方案**：
- A. 全量上线：所有 Edge 同时启用
- B. 金丝雀：先在少数 Edge 启用，观察效果
- C. 灰度发布：逐步增加启用比例
- D. 区域隔离：先在某个地理区域试点

**请选择**：推荐的部署方式？

---

#### Q17: 回滚计划
**问题**: 如果中转路由出现问题，如何快速回滚？

**需求**：
- 是否需要配置热更新？（无需重启 Edge）
- 是否需要紧急开关？（一键禁用中转）
- 回滚后的状态：回到纯直连 or 保留部分功能？

---

### 11.9 性能调优

#### Q18: 性能目标
**问题**: 对于中转路由，可接受的性能目标是什么？

**需要确认**：
- 中转延迟增量上限：< 5ms? < 10ms? < 20ms?
- 中转丢包率上限：< 1%? < 3%? < 5%?
- 中转 CPU 开销上限：< 10%? < 20%? < 30%?
- 集群规模目标：10 Edge? 50 Edge? 100 Edge?

---

#### Q19: 优化优先级
**问题**: 如果性能不足，优先优化哪方面？

**候选方向**：
- A. 降低延迟：优化转发路径，减少处理时间
- B. 提高吞吐：优化包处理，支持更多并发
- C. 降低开销：减少探测频率，简化路由计算
- D. 提升稳定性：减少路由抖动，提高可靠性

**请排序**：优先级从高到低

---

## 十二、决策矩阵

为便于快速决策，将关键问题总结如下：

| 问题 ID | 问题简述 | 推荐选项 | 优先级 | 状态 |
|---------|---------|---------|--------|------|
| Q1 | 路由切换阈值 | 保守切换（RTT>500ms, 丢包>10%） | 高 | 确认 |
| Q2 | 切换滞后时间 | 3-5 秒 | 高 | 确认 |
| Q3 | 成本计算公式 | RTT + 丢包×1000, 中转×1.2 | 高 | 确认 |
| Q4 | 中转节点选择 | 混合模式（优选+自动） | 高 | 确认 |
| Q5 | 中转容量限制 | CPU/带宽分别限制，静态阈值，降低优先级 | 中 | ✅ 确认 |
| Q6 | 探测频率方法 | 10秒间隔，完全被动探测 | 中 | ✅ 确认 |
| Q7 | 探测包大小 | 不需要（使用被动探测） | 低 | ✅ 确认 |
| Q8 | TCP 降级触发 | 主动保持备用通道 | 高 | 确认 |
| Q9 | TCP 降级恢复 | 30秒检查，稳定后切换 | 中 | 确认 |
| Q10 | Hub 路由计算频率 | 30秒 + 事件驱动 | 中 | 确认 |
| Q11 | Hub 是否中转 | Hub 完全不参与 UDP 中转，仅 TCP 降级 | 高 | ✅ 确认 |
| Q12 | 监控指标 | RTT/丢包/路由类型/中转负载 | 高 | 确认 |
| Q13 | 调试工具 | 路由表查看 + 质量查看 | 中 | 确认 |
| Q14 | 旧版本兼容 | 无需兼容 | 中 | 确认 |
| Q15 | 客户端感知 | 完全透明 | 高 | 确认 |
| Q16 | 部署策略 | 一次全部部署，无需灰度 | 高 | 确认 |
| Q17 | 回滚计划 | 无需考虑回滚 | 高 | 确认 |
| Q18 | 性能目标 | 无性能目标 | 高 | 确认 |
| Q19 | 优化优先级 | 稳定性 > 延迟 > 吞吐 > 开销 | 中 | 确认 |

**下一步**: 请逐项确认或修改推荐选项，完成后即可进入开发阶段。

---

**文档维护者**: MuNode 开发团队  
**最后更新**: 2025-12-01
