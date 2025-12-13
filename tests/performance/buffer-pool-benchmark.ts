/**
 * Buffer Pool Performance Benchmark
 * 
 * Compares performance difference between using buffer pool and direct buffer allocation
 */

import { BufferPool } from '@munode/common';
import { performance } from 'perf_hooks';

/**
 * Simulate voice packet processing scenario
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
      // Use buffer pool
      buffer = pool.acquire(packetSize);
      
      // Simulate buffer usage (write data)
      for (let j = 0; j < Math.min(packetSize, 10); j++) {
        buffer[j] = (i + j) & 0xff;
      }
      
      // Release back to pool
      pool.release(buffer);
    } else {
      // Direct allocation
      buffer = Buffer.allocUnsafe(packetSize);
      
      // Simulate buffer usage (write data)
      for (let j = 0; j < Math.min(packetSize, 10); j++) {
        buffer[j] = (i + j) & 0xff;
      }
      
      // No explicit release needed, wait for GC
    }
  }
  
  const duration = performance.now() - start;
  const avgMs = duration / iterations;
  
  return { duration, avgMs };
}

/**
 * Run benchmark tests
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
    
    // Warm up V8
    simulateVoicePacketProcessing(false, 1000, testCase.size);
    simulateVoicePacketProcessing(true, 1000, testCase.size);
    
    // Without pool
    const withoutPool = simulateVoicePacketProcessing(
      false,
      testCase.iterations,
      testCase.size
    );
    
    // With pool
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
  
  // Buffer pool statistics test
  console.log('Buffer Pool Statistics Test');
  console.log('='.repeat(80));
  console.log();
  
  const pool = new BufferPool(100);
  pool.warmup(50);
  
  // Simulate real-world usage
  const buffers: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    buffers.push(pool.acquire(128 + Math.floor(Math.random() * 200)));
  }
  
  // Release half
  for (let i = 0; i < 10; i++) {
    pool.release(buffers[i]);
  }
  
  // Get statistics
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

// Run benchmark
runBenchmark();
