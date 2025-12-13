/**
 * Buffer Pool Performance Benchmark
 * 
 * 比较使用 buffer 池和直接分配 buffer 的性能差异
 */

import { BufferPool } from '@munode/common';
import { performance } from 'perf_hooks';

/**
 * 模拟语音包处理场景
 */
function simulateVoicePacketProcessing(
  usePool: boolean,
  iterations: number,
  packetSize: number
): { duration: number; avgMs: number } {
  const pool = usePool ? new BufferPool(100) : null;
  
  if (pool) {
    pool.warmup(50);
  }
  
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    let buffer: Buffer;
    
    if (pool) {
      // 使用 buffer 池
      buffer = pool.acquire(packetSize);
      
      // 模拟使用 buffer（写入数据）
      for (let j = 0; j < Math.min(packetSize, 10); j++) {
        buffer[j] = (i + j) & 0xff;
      }
      
      // 释放回池
      pool.release(buffer);
    } else {
      // 直接分配
      buffer = Buffer.allocUnsafe(packetSize);
      
      // 模拟使用 buffer（写入数据）
      for (let j = 0; j < Math.min(packetSize, 10); j++) {
        buffer[j] = (i + j) & 0xff;
      }
      
      // 不需要显式释放，等待 GC
    }
  }
  
  const duration = performance.now() - start;
  const avgMs = duration / iterations;
  
  return { duration, avgMs };
}

/**
 * 运行基准测试
 */
function runBenchmark(): void {
  console.log('Buffer Pool Performance Benchmark');
  console.log('='.repeat(80));
  console.log();
  
  const testCases = [
    { name: 'Small packets (128 bytes)', size: 128, iterations: 100000 },
    { name: 'Medium packets (256 bytes)', size: 256, iterations: 100000 },
    { name: 'Large packets (512 bytes)', size: 512, iterations: 50000 },
  ];
  
  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);
    console.log(`Iterations: ${testCase.iterations.toLocaleString()}`);
    console.log();
    
    // 预热 V8
    simulateVoicePacketProcessing(false, 1000, testCase.size);
    simulateVoicePacketProcessing(true, 1000, testCase.size);
    
    // 不使用池
    const withoutPool = simulateVoicePacketProcessing(
      false,
      testCase.iterations,
      testCase.size
    );
    
    // 使用池
    const withPool = simulateVoicePacketProcessing(
      true,
      testCase.iterations,
      testCase.size
    );
    
    console.log(`  Without pool: ${withoutPool.duration.toFixed(2)}ms (avg: ${withoutPool.avgMs.toFixed(6)}ms/packet)`);
    console.log(`  With pool:    ${withPool.duration.toFixed(2)}ms (avg: ${withPool.avgMs.toFixed(6)}ms/packet)`);
    
    const improvement = ((withoutPool.duration - withPool.duration) / withoutPool.duration) * 100;
    console.log(`  Improvement:  ${improvement.toFixed(2)}% faster`);
    console.log();
  }
  
  // Buffer 池统计测试
  console.log('Buffer Pool Statistics Test');
  console.log('='.repeat(80));
  console.log();
  
  const pool = new BufferPool(100);
  pool.warmup(50);
  
  // 模拟实际使用场景
  const buffers: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    buffers.push(pool.acquire(128 + Math.floor(Math.random() * 200)));
  }
  
  // 释放一半
  for (let i = 0; i < 10; i++) {
    pool.release(buffers[i]);
  }
  
  // 获取统计信息
  const stats = pool.getStats();
  console.log('Pool Statistics:');
  for (const stat of stats) {
    console.log(`  Pool Size: ${stat.poolSize} bytes`);
    console.log(`    Total buffers: ${stat.total}`);
    console.log(`    In use: ${stat.inUse}`);
    console.log(`    Available: ${stat.available}`);
    console.log(`    Total acquires: ${stat.acquireCount}`);
    console.log(`    Hit rate: ${stat.hitRate.toFixed(2)}%`);
    console.log();
  }
}

// 运行基准测试
runBenchmark();
