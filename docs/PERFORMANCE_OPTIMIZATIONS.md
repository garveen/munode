# Edge Server UDP 性能优化总结

## 概述

本文档总结了针对 Edge Server UDP 收发（包括 TCP UDP tunnel 转发）的性能优化工作。这些优化在保持与 Mumble 官方客户端接口兼容性的前提下，显著提升了系统性能。

## 优化目标

Edge<->Client 的 UDP 收发是系统的核心性能消耗来源，主要瓶颈包括：
1. **OCB2-AES128 加解密**：每个语音包都需要加解密
2. **Buffer 分配**：大量临时 Buffer 分配导致 GC 压力
3. **函数调用开销**：每次 UDP 发送都创建新的回调函数

## 实施的优化

### 1. OCB2-AES128 加密优化

#### 1.1 复用工作 Buffer
**问题**：每次加密/解密都分配新的 `checksum` 和 `tmp` Buffer

**优化**：
```typescript
// 优化前
private ocbEncrypt(...): Buffer {
  const checksum = Buffer.alloc(OCB2AES128.BLOCK_SIZE);
  const tmp = Buffer.alloc(OCB2AES128.BLOCK_SIZE);
  // ...
}

// 优化后
private readonly workBuffer = {
  checksum: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
  tmp: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
  saveiv: Buffer.alloc(OCB2AES128.BLOCK_SIZE),
};

private ocbEncrypt(...): Buffer {
  const checksum = this.workBuffer.checksum;
  const tmp = this.workBuffer.tmp;
  // ...
}
```

**收益**：减少 GC 压力，每次加密节省 2-3 次 Buffer 分配

#### 1.2 XOR 操作循环展开
**问题**：逐字节 XOR 操作效率低

**优化**：
```typescript
// 优化前
private xor(dst: Buffer, a: Buffer, b: Buffer): void {
  for (let i = 0; i < OCB2AES128.BLOCK_SIZE; i++) {
    dst[i] = a[i] ^ b[i];
  }
}

// 优化后 - 循环展开
private xor(dst: Buffer, a: Buffer, b: Buffer): void {
  dst[0] = a[0] ^ b[0];
  dst[1] = a[1] ^ b[1];
  // ... 展开16次
  dst[15] = a[15] ^ b[15];
}
```

**收益**：V8 JIT 可以更好地优化展开的循环，减少循环控制开销

#### 1.3 使用 Buffer.allocUnsafe
**问题**：`Buffer.alloc()` 会初始化内存为 0，但数据会被立即覆盖

**优化**：
```typescript
// 优化前
const cipherText = Buffer.alloc(plainText.length + 4);
const plainText = Buffer.alloc(cipherText.length - 4);

// 优化后
const cipherText = Buffer.allocUnsafe(plainText.length + 4);
const plainText = Buffer.allocUnsafe(cipherText.length - 4);
```

**收益**：跳过内存清零操作，减少 CPU 时间

### 2. VoiceRouter UDP 发送优化

#### 2.1 复用 UDP 发送回调函数
**问题**：每次发送 UDP 包都创建新的回调函数

**优化**：
```typescript
// 优化前
this.udpServer.send(encrypted, port, ip, (err) => {
  if (err) {
    this.logger.error(`Failed to send...`, err);
    this.clientManager.updateClient(session, { udp: false });
  }
});

// 优化后
private udpErrorHandlers: Map<number, (err?: Error) => void> = new Map();

// 创建并缓存错误处理器
let errorHandler = this.udpErrorHandlers.get(client.session);
if (!errorHandler) {
  errorHandler = (err?: Error) => {
    if (err) {
      this.logger.error(`Failed to send...`, err);
      this.clientManager.updateClient(client.session, { udp: false });
    }
  };
  this.udpErrorHandlers.set(client.session, errorHandler);
}

this.udpServer.send(encrypted, port, ip, errorHandler);
```

**收益**：减少函数对象分配，降低 GC 压力

### 3. Buffer 池工具类

#### 3.1 创建 BufferPool
**目的**：复用常见大小的 Buffer，减少分配和 GC

**实现**：
```typescript
export class BufferPool {
  private pools: Map<number, PoolEntry[]> = new Map();
  private static readonly COMMON_SIZES = [128, 256, 512, 1024, 2048];
  
  acquire(size: number): Buffer { /* ... */ }
  release(buffer: Buffer): void { /* ... */ }
  warmup(count: number = 50): void { /* ... */ }
}

// 全局实例
export const globalBufferPool = new BufferPool(100);
```

**特性**：
- 预定义常见语音包大小（128-2048 字节）
- 支持预热（提前分配）
- 自动限制池大小
- 提供统计信息接口

**注意**：目前已创建但未集成到 OCB2，可在后续优化中使用

## 性能测试结果

### 测试环境
- Node.js v20.19.6
- 测试包大小：480 字节（典型语音包）
- 测试迭代：10,000 次

### OCB2-AES128 性能对比

#### 加密性能

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 平均时间 | ~74.69 μs | 36.99 μs | **50.5%** |
| P50 | ~68.96 μs | 32.05 μs | **53.5%** |
| P95 | ~88.70 μs | 46.72 μs | **47.3%** |
| P99 | ~214.46 μs | 89.66 μs | **58.2%** |

#### 解密性能

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 平均时间 | ~46.49 μs | 23.08 μs | **50.3%** |
| P50 | ~68.93 μs | 32.57 μs | **52.7%** |
| P95 | ~81.15 μs | 44.36 μs | **45.3%** |
| P99 | ~155.45 μs | 60.45 μs | **61.1%** |

#### 综合性能

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 吞吐量 | 16,504 ops/s | 33,293 ops/s | **101.7%** |
| 带宽 | 7.55 MB/s | 15.24 MB/s | **101.9%** |

### 不同包大小性能

| 包大小 | 加密平均 | 解密平均 | 吞吐量 |
|--------|----------|----------|--------|
| 128B | 11.13 μs | 7.39 μs | 107,999 ops/s |
| 480B | 36.14 μs | 23.34 μs | 33,621 ops/s |
| 1024B | 75.33 μs | 47.39 μs | 16,297 ops/s |

### 内存使用

优化后内存使用更稳定：
- 堆使用：~14 MB（优化前 ~16 MB）
- 外部内存：~7-10 MB（根据包大小变化）

## 关键发现

### 1. 循环展开效果显著
将 16 字节的 XOR 循环展开为 16 个直接赋值，V8 JIT 可以更好地优化，性能提升明显。

### 2. DataView 在热路径中开销较大
最初尝试使用 DataView + BigUint64 进行批量 XOR，但在热路径中反而更慢（-565% 性能下降）。这是因为每次操作都创建 DataView 对象的开销超过了批量操作的收益。

### 3. Buffer.allocUnsafe 的适用场景
只在数据会被完全覆盖的场景使用，如：
- 加密输出缓冲区
- 解密输出缓冲区
- 临时工作缓冲区

不适用场景：
- 部分填充的缓冲区
- 可能暴露未初始化内存的场景

## 实际影响

### 语音通话场景
假设 20ms 音频帧（Opus 典型配置）：
- 帧率：50 帧/秒
- 每帧加密+解密时间（优化后）：~60 μs
- CPU 占用：60 μs × 50 = 3ms/秒 = **0.3% CPU**

对于 100 个并发用户：
- 总 CPU 时间：100 × 3ms = 300ms/秒 = **30% CPU**
- 优化前需要：100 × 6ms = 600ms/秒 = **60% CPU**
- **节省 50% CPU 资源**

### 可扩展性提升
在相同硬件上：
- 优化前：~166 并发用户（假设 CPU 限制在 100%）
- 优化后：~333 并发用户
- **容量翻倍**

## 后续优化建议

### 1. 集成 BufferPool
在 OCB2 加密输出中使用 BufferPool：
```typescript
const cipherText = globalBufferPool.acquire(plainText.length + 4);
// ... 使用 ...
globalBufferPool.release(cipherText);
```

预期额外提升：5-10%

### 2. SIMD 优化（实验性）
考虑使用 WebAssembly SIMD 指令优化 AES 和 XOR 操作，但需要：
- 评估 WebAssembly 互操作开销
- 考虑跨平台兼容性
- 进行详细的性能对比测试

### 3. Worker 线程池
对于极高并发场景（1000+ 用户），考虑：
- 使用 Worker 线程池处理加解密
- 主线程专注于 I/O 和路由
- 需要解决消息传递开销问题

### 4. 批量处理
收集多个语音包后批量加密/解密，减少函数调用开销：
- 权衡延迟和吞吐量
- 适用于转发场景，不适用于实时语音

## 兼容性

所有优化都保持了与 Mumble 官方客户端的完全兼容性：
- OCB2-AES128 算法逻辑未变
- UDP 协议未变
- 数据包格式未变
- 仅优化内部实现

## 测试验证

### 运行性能基准测试
```bash
# 编译项目
pnpm build

# 运行 OCB2 性能测试
npx tsx tests/performance/ocb2-benchmark.ts
```

### 运行集成测试
```bash
# 确保功能正确性
pnpm test:integration
```

## 总结

通过一系列针对性的优化，我们成功地将 Edge Server 的 UDP 处理性能提升了约 **100%**（2倍），同时降低了内存使用和 GC 压力。这些优化使得单个 Edge 服务器可以支持更多的并发用户，显著提升了系统的可扩展性。

最重要的是，所有优化都在保持与 Mumble 官方客户端完全兼容的前提下完成，不影响现有功能和用户体验。
