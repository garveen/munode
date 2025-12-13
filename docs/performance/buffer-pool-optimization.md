# Buffer Pool Optimization for Voice Packets

## 概述

本优化针对 MuNode 语音包处理进行了 buffer 管理优化，主要目标是减少频繁的 buffer 创建和销毁，降低 GC 压力，提升语音包处理性能。

## 问题分析

### Mumble 语音包特性

- **持续时间**: 10-60ms（可配置）
- **码率**: 10-40kbps（Opus 编码）
- **包大小**:
  - 原始载荷: ~50-300 bytes
  - 带头部/加密: ~70-350 bytes
- **频率**: 每秒 16-100 个包（取决于持续时间配置）

### 原有问题

1. **频繁的 Buffer 创建**: 每个语音包处理过程中会创建多个临时 buffer
2. **Buffer.concat 开销**: 多次使用 `Buffer.concat` 合并 buffer，每次都需要分配新内存并复制数据
3. **GC 压力**: 大量短生命周期的 buffer 对象增加垃圾回收压力

## 优化方案

### 1. Buffer 池增强

增强了 `@munode/common/util/buffer-pool.ts` 的功能：

#### 池大小配置
```typescript
// 针对 Mumble 语音包优化的池大小
const COMMON_SIZES = [128, 256, 512];
const MAX_POOL_SIZE = 100; // 每个大小保留 100 个 buffer
```

#### 新增功能
- **预热机制**: `warmup()` 在服务启动时预分配 buffer
- **统计监控**: 追踪获取次数、命中率等指标
- **自动清理**: `cleanup()` 清理长时间未使用的 buffer
- **性能优化**: 反向遍历提高查找效率

### 2. 消除 Buffer.concat

在以下关键路径中用直接复制替代 `Buffer.concat`：

#### voice-router.ts
- **序列化语音包**: `serializeVoicePacket()` 使用 buffer 池并直接写入 buffer
- **Varint 编码优化**: 新增 `encodeVarintTo()` 直接写入目标 buffer

#### voice-udp-transport.ts
- **发送到 Edge**: 直接复制替代 concat
- **广播**: 一次性分配完整 buffer
- **加解密**: 手动组装加密/解密结果

#### voice-packet.ts
- **编码包**: 消除加密过程中的 concat
- **解码包**: 消除解密过程中的 concat

### 3. 跨进程优化

对于跨 Edge 的数据交换，采用以下策略：

1. **复用序列化结果**: 广播到多个 Edge 时，只序列化一次
2. **传递 serializedData**: 远程语音包处理时直接使用已序列化的数据
3. **避免重复加密**: 广播加密一次，所有接收方复用

## 使用指南

### 启用 Buffer 池

```typescript
import { globalBufferPool } from '@munode/common';

// 可选：在启动时预热池
globalBufferPool.warmup(50);
```

### 查看统计信息

```typescript
const stats = globalBufferPool.getStats();
for (const stat of stats) {
  console.log(`Pool ${stat.poolSize}: Hit Rate ${stat.hitRate}%`);
}
```

## 性能特性

- **减少内存分配**: 避免每个语音包创建多个临时 buffer
- **降低 GC 压力**: 复用 buffer，减少垃圾回收频率
- **提升缓存效率**: 减少内存复制操作
- **稳定延迟**: 避免 GC 停顿导致的延迟抖动
