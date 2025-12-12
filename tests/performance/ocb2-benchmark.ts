/**
 * OCB2-AES128 性能基准测试
 * 
 * 测试加密和解密性能，比较优化前后的差异
 * 
 * 运行方式: tsx tests/performance/ocb2-benchmark.ts
 */

import { OCB2AES128 } from '@munode/common';
import { randomBytes } from 'crypto';

/**
 * 性能统计
 */
interface PerfStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * 计算性能统计
 */
function calculateStats(times: number[]): PerfStats {
  const sorted = times.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

/**
 * 格式化时间（微秒）
 */
function formatTime(us: number): string {
  if (us < 1000) {
    return `${us.toFixed(2)}μs`;
  } else if (us < 1000000) {
    return `${(us / 1000).toFixed(2)}ms`;
  } else {
    return `${(us / 1000000).toFixed(2)}s`;
  }
}

/**
 * OCB2 加密性能测试
 */
async function benchmarkOCB2(
  iterations: number = 10000,
  packetSize: number = 480
): Promise<void> {
  console.log(`\n=== OCB2-AES128 性能基准测试 ===`);
  console.log(`迭代次数: ${iterations}`);
  console.log(`数据包大小: ${packetSize} bytes`);
  console.log(`目标: 模拟典型语音包加解密场景\n`);
  
  // 初始化加密器
  const ocb = new OCB2AES128();
  ocb.generateKey();
  
  // 准备测试数据
  const testData = randomBytes(packetSize);
  
  // 预热（避免JIT编译影响）
  console.log('预热中...');
  for (let i = 0; i < 1000; i++) {
    const encrypted = ocb.encrypt(testData);
    ocb.decrypt(encrypted);
  }
  
  // 加密性能测试
  console.log('\n测试加密性能...');
  const encryptTimes: number[] = [];
  const encryptedPackets: Buffer[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const encrypted = ocb.encrypt(testData);
    const end = process.hrtime.bigint();
    
    encryptTimes.push(Number(end - start) / 1000); // 转换为微秒
    encryptedPackets.push(encrypted);
  }
  
  const encryptStats = calculateStats(encryptTimes);
  console.log('\n加密性能统计 (μs):');
  console.log(`  最小值: ${formatTime(encryptStats.min)}`);
  console.log(`  平均值: ${formatTime(encryptStats.avg)}`);
  console.log(`  P50:    ${formatTime(encryptStats.p50)}`);
  console.log(`  P95:    ${formatTime(encryptStats.p95)}`);
  console.log(`  P99:    ${formatTime(encryptStats.p99)}`);
  console.log(`  最大值: ${formatTime(encryptStats.max)}`);
  
  // 解密性能测试
  console.log('\n测试解密性能...');
  const decryptTimes: number[] = [];
  let validCount = 0;
  
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const result = ocb.decrypt(encryptedPackets[i]);
    const end = process.hrtime.bigint();
    
    decryptTimes.push(Number(end - start) / 1000);
    if (result.valid) validCount++;
  }
  
  const decryptStats = calculateStats(decryptTimes);
  console.log('\n解密性能统计 (μs):');
  console.log(`  最小值: ${formatTime(decryptStats.min)}`);
  console.log(`  平均值: ${formatTime(decryptStats.avg)}`);
  console.log(`  P50:    ${formatTime(decryptStats.p50)}`);
  console.log(`  P95:    ${formatTime(decryptStats.p95)}`);
  console.log(`  P99:    ${formatTime(decryptStats.p99)}`);
  console.log(`  最大值: ${formatTime(decryptStats.max)}`);
  console.log(`  成功率: ${((validCount / iterations) * 100).toFixed(2)}%`);
  
  // 综合性能
  const totalTime = encryptTimes.reduce((a, b) => a + b, 0) + decryptTimes.reduce((a, b) => a + b, 0);
  const throughput = (iterations * 2 * 1000000) / totalTime; // 包/秒（加密+解密）
  
  console.log('\n综合性能:');
  console.log(`  总时间: ${formatTime(totalTime)}`);
  console.log(`  吞吐量: ${throughput.toFixed(0)} 操作/秒`);
  console.log(`  带宽: ${((throughput * packetSize) / (1024 * 1024)).toFixed(2)} MB/s`);
  
  // 性能目标检查
  console.log('\n性能目标检查:');
  const targetEncryptAvg = 50; // 目标：平均加密时间 < 50μs
  const targetDecryptAvg = 50; // 目标：平均解密时间 < 50μs
  
  console.log(`  ✓ 加密平均时间 < ${targetEncryptAvg}μs: ${encryptStats.avg < targetEncryptAvg ? '通过' : '失败'}`);
  console.log(`  ✓ 解密平均时间 < ${targetDecryptAvg}μs: ${decryptStats.avg < targetDecryptAvg ? '通过' : '失败'}`);
  console.log(`  ✓ 成功率 = 100%: ${validCount === iterations ? '通过' : '失败'}`);
  
  // 内存使用
  const memUsage = process.memoryUsage();
  console.log('\n内存使用:');
  console.log(`  堆使用: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  外部内存: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`);
}

/**
 * 测试不同包大小的性能
 */
async function benchmarkDifferentSizes(): Promise<void> {
  console.log('\n=== 不同包大小性能测试 ===\n');
  
  const sizes = [
    { name: '小包 (128B)', size: 128 },
    { name: '典型语音包 (480B)', size: 480 },
    { name: '大包 (1024B)', size: 1024 },
  ];
  
  for (const { name, size } of sizes) {
    console.log(`\n--- ${name} ---`);
    await benchmarkOCB2(5000, size);
  }
}

/**
 * XOR 性能专项测试
 */
async function benchmarkXOR(): Promise<void> {
  console.log('\n=== XOR 操作性能测试 ===\n');
  
  const iterations = 1000000;
  const blockSize = 16;
  
  // 准备测试数据
  const a = Buffer.alloc(blockSize);
  const b = Buffer.alloc(blockSize);
  const dst = Buffer.alloc(blockSize);
  
  for (let i = 0; i < blockSize; i++) {
    a[i] = Math.floor(Math.random() * 256);
    b[i] = Math.floor(Math.random() * 256);
  }
  
  // 测试逐字节 XOR
  console.log('测试逐字节 XOR...');
  let start = process.hrtime.bigint();
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < blockSize; i++) {
      dst[i] = a[i] ^ b[i];
    }
  }
  let end = process.hrtime.bigint();
  const byteXorTime = Number(end - start) / 1000; // 微秒
  console.log(`  时间: ${formatTime(byteXorTime)}`);
  console.log(`  速率: ${(iterations * 1000000 / byteXorTime).toFixed(0)} 操作/秒`);
  
  // 测试 BigUint64 XOR
  console.log('\n测试 BigUint64 XOR...');
  start = process.hrtime.bigint();
  for (let iter = 0; iter < iterations; iter++) {
    const dstView = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
    const aView = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
    
    const a0 = aView.getBigUint64(0, false);
    const b0 = bView.getBigUint64(0, false);
    dstView.setBigUint64(0, a0 ^ b0, false);
    
    const a1 = aView.getBigUint64(8, false);
    const b1 = bView.getBigUint64(8, false);
    dstView.setBigUint64(8, a1 ^ b1, false);
  }
  end = process.hrtime.bigint();
  const bigintXorTime = Number(end - start) / 1000;
  console.log(`  时间: ${formatTime(bigintXorTime)}`);
  console.log(`  速率: ${(iterations * 1000000 / bigintXorTime).toFixed(0)} 操作/秒`);
  
  // 性能对比
  const improvement = ((byteXorTime - bigintXorTime) / byteXorTime * 100);
  console.log(`\n性能提升: ${improvement.toFixed(2)}%`);
}

/**
 * 主函数
 */
async function main() {
  console.log('OCB2-AES128 性能基准测试');
  console.log('=' .repeat(60));
  
  // 基础性能测试
  await benchmarkOCB2(10000, 480);
  
  // 不同大小测试
  await benchmarkDifferentSizes();
  
  // XOR专项测试
  await benchmarkXOR();
  
  console.log('\n' + '='.repeat(60));
  console.log('测试完成！');
}

// 运行测试
main().catch(console.error);
