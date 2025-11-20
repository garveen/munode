const { OCB2AES128 } = require('./packages/edge-server/dist/ocb2-aes128.js');

// 测试 OCB2-AES128 实现
function testOCB2AES128() {
  console.log('Testing OCB2-AES128 implementation...\n');

  const crypto = new OCB2AES128();

  // 测试1: 密钥生成
  console.log('1. Testing key generation...');
  crypto.generateKey();
  console.log('✓ Key generated successfully');

  // 测试2: 基本加密解密 (不使用IV同步，直接测试)
  console.log('\n2. Testing basic encrypt/decrypt...');
  const testData = Buffer.from('Hello, Mumble OCB2!');
  console.log(`Original: "${testData.toString()}" (${testData.length} bytes)`);

  // 模拟真实场景：两个实例共享相同的初始IV
  const sharedIV = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  crypto.setKey(crypto.getKey(), sharedIV, sharedIV);

  console.log('Shared IV initial:', sharedIV);
  console.log('Encrypt IV before:', crypto.getEncryptIV());
  const encrypted = crypto.encrypt(testData);
  console.log('Encrypt IV after:', crypto.getEncryptIV());
  console.log(`Encrypted: ${encrypted.length} bytes (overhead: 4 bytes)`);
  console.log('Encrypted bytes:', encrypted);

  // crypto2使用与crypto encryptIV相同的IV（递增后的）
  const crypto2 = new OCB2AES128();
  crypto2.setKey(crypto.getKey(), crypto.getEncryptIV(), crypto.getEncryptIV());

  console.log('Decrypt IV before:', crypto2.getDecryptIV());
  const decrypted = crypto2.decrypt(encrypted);
  console.log('Decrypt IV after:', crypto2.getDecryptIV());
  console.log(`Decrypted: "${decrypted.data.toString()}" (${decrypted.data.length} bytes)`);
  console.log(`Valid: ${decrypted.valid}`);
  console.log(`Match: ${testData.equals(decrypted.data) ? '✓' : '✗'}`);

  // 测试3: 多个包的加密解密（模拟真实UDP场景）
  console.log('\n3. Testing multiple packets...');
  const crypto3 = new OCB2AES128();
  const crypto4 = new OCB2AES128();

  // 设置相同的初始密钥
  const key = Buffer.from([0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42]);
  const iv1 = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const iv2 = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  crypto3.setKey(key, iv1, iv2);
  crypto4.setKey(key, iv2, iv1); // 注意：解密使用对方的加密IV

  const messages = ['Packet 1', 'Packet 2', 'Packet 3'];
  let successCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = Buffer.from(messages[i]);
    const enc = crypto3.encrypt(msg);
    const dec = crypto4.decrypt(enc);

    console.log(`  ${messages[i]}: ${dec.valid && msg.equals(dec.data) ? '✓' : '✗'}`);
    if (dec.valid && msg.equals(dec.data)) {
      successCount++;
    }
  }

  console.log(`Multiple packets test: ${successCount}/${messages.length} passed`);

  console.log('\n✓ All tests completed!');
}

// 运行测试
testOCB2AES128();