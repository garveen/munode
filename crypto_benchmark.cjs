const crypto = require('crypto');
const { performance } = require('perf_hooks');

// 测试数据
const testData = Buffer.alloc(1024, 'a'); // 1KB 测试数据
const iterations = 10000;

// AES-128-OCB 测试
function testAES128OCB() {
  const key = Buffer.alloc(16, 1); // 128位密钥
  const iv = Buffer.alloc(12, 2);  // 96位IV for OCB

  console.log('Testing AES-128-OCB...');

  // 加密测试
  const startEncrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const cipher = crypto.createCipheriv('aes-128-ocb', key, iv);
    cipher.setAAD(Buffer.alloc(0));
    const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
    const authTag = cipher.getAuthTag();
  }
  const encryptTime = performance.now() - startEncrypt;

  // 解密测试
  const cipher = crypto.createCipheriv('aes-128-ocb', key, iv);
  cipher.setAAD(Buffer.alloc(0));
  const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const startDecrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const decipher = crypto.createDecipheriv('aes-128-ocb', key, iv);
    decipher.setAAD(Buffer.alloc(0));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  const decryptTime = performance.now() - startDecrypt;

  return {
    encrypt: encryptTime,
    decrypt: decryptTime,
    total: encryptTime + decryptTime
  };
}

// ChaCha20-Poly1305 测试
function testChaCha20Poly1305() {
  const key = Buffer.alloc(32, 1); // 256位密钥
  const iv = Buffer.alloc(12, 2);  // 96位IV

  console.log('Testing ChaCha20-Poly1305...');

  // 加密测试
  const startEncrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, iv);
    cipher.setAAD(Buffer.alloc(0));
    const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
    const authTag = cipher.getAuthTag();
  }
  const encryptTime = performance.now() - startEncrypt;

  // 解密测试
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, iv);
  cipher.setAAD(Buffer.alloc(0));
  const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const startDecrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, iv);
    decipher.setAAD(Buffer.alloc(0));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  const decryptTime = performance.now() - startDecrypt;

  return {
    encrypt: encryptTime,
    decrypt: decryptTime,
    total: encryptTime + decryptTime
  };
}

// AES-128-GCM 测试 (作为对比)
function testAES128GCM() {
  const key = Buffer.alloc(16, 1); // 128位密钥
  const iv = Buffer.alloc(12, 2);  // 96位IV

  console.log('Testing AES-128-GCM...');

  // 加密测试
  const startEncrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const cipher = crypto.createCipherGCM('aes-128-gcm', key, iv);
    cipher.setAAD(Buffer.alloc(0));
    const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
    const authTag = cipher.getAuthTag();
  }
  const encryptTime = performance.now() - startEncrypt;

  // 解密测试
  const cipher = crypto.createCipherGCM('aes-128-gcm', key, iv);
  cipher.setAAD(Buffer.alloc(0));
  const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const startDecrypt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const decipher = crypto.createDecipherGCM('aes-128-gcm', key, iv);
    decipher.setAAD(Buffer.alloc(0));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  const decryptTime = performance.now() - startDecrypt;

  return {
    encrypt: encryptTime,
    decrypt: decryptTime,
    total: encryptTime + decryptTime
  };
}

// 运行测试
async function runTests() {
  console.log(`Running ${iterations} iterations with ${testData.length} bytes of data...\n`);

  try {
    const results = {
      'AES-128-OCB': testAES128OCB(),
      'ChaCha20-Poly1305': testChaCha20Poly1305(),
      'AES-128-GCM': testAES128GCM()
    };

    console.log('\nResults (milliseconds):');
    console.log('='.repeat(60));

    Object.entries(results).forEach(([name, times]) => {
      console.log(`${name.padEnd(20)} | Encrypt: ${times.encrypt.toFixed(2).padStart(8)} | Decrypt: ${times.decrypt.toFixed(2).padStart(8)} | Total: ${times.total.toFixed(2).padStart(8)}`);
    });

    // 计算每秒操作数
    console.log('\nOperations per second:');
    console.log('='.repeat(60));

    Object.entries(results).forEach(([name, times]) => {
      const opsPerSec = (iterations * 2) / (times.total / 1000); // encrypt + decrypt
      console.log(`${name.padEnd(20)} | ${opsPerSec.toFixed(0).padStart(8)} ops/sec`);
    });

  } catch (error) {
    console.error('Test failed:', error);
  }
}

runTests();