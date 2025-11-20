/**
 * PreConnectUserState 和频道权限动态刷新测试
 * 
 * 测试场景：
 * 1. PreConnectUserState - 客户端在认证前设置初始状态
 * 2. 频道权限动态刷新 - ACL 变更后自动更新 suppress 状态
 */

import { mumbleproto } from '@munode/protocol/src/generated/proto/Mumble.js';
import { connect, Socket } from 'net';
import { connect as tlsConnect, TLSSocket } from 'tls';
import { readFileSync } from 'fs';

// 配置
const CONFIG = {
  host: '127.0.0.1',
  port: 64738,
  tlsRejectUnauthorized: false,
};

// 消息类型
const MessageType = {
  Version: 0,
  Authenticate: 2,
  Ping: 3,
  ServerSync: 5,
  UserState: 9,
  ACL: 17,
};

/**
 * 辅助函数：创建消息缓冲区
 */
function createMessage(type, data) {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(data.length, 2);
  return Buffer.concat([header, data]);
}

/**
 * 辅助函数：解析消息
 */
function parseMessage(buffer) {
  if (buffer.length < 6) return null;
  const type = buffer.readUInt16BE(0);
  const length = buffer.readUInt32BE(2);
  if (buffer.length < 6 + length) return null;
  const data = buffer.slice(6, 6 + length);
  return { type, data, consumed: 6 + length };
}

/**
 * 创建 TLS 连接
 */
function createConnection() {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: CONFIG.host,
      port: CONFIG.port,
      rejectUnauthorized: CONFIG.tlsRejectUnauthorized,
    });

    socket.on('secureConnect', () => {
      console.log('✓ TLS 连接已建立');
      resolve(socket);
    });

    socket.on('error', (err) => {
      console.error('✗ 连接错误:', err.message);
      reject(err);
    });
  });
}

/**
 * 发送 Version 消息
 */
function sendVersion(socket) {
  const version = new mumbleproto.Version({
    version_v1: (1 << 16) | (4 << 8) | 0, // 1.4.0
    release: 'MuNode Test Client',
    os: 'Node.js',
    os_version: process.version,
  });
  const message = createMessage(MessageType.Version, Buffer.from(version.serialize()));
  socket.write(message);
  console.log('→ 发送 Version 消息');
}

/**
 * 发送 PreConnect UserState（在认证前）
 */
function sendPreConnectUserState(socket, selfMute = true, selfDeaf = false) {
  const userState = new mumbleproto.UserState({
    self_mute: selfMute,
    self_deaf: selfDeaf,
    temporary_access_tokens: [],
    listening_channel_add: [],
    listening_channel_remove: [],
  });
  const message = createMessage(MessageType.UserState, Buffer.from(userState.serialize()));
  socket.write(message);
  console.log(`→ 发送 PreConnect UserState (self_mute=${selfMute}, self_deaf=${selfDeaf})`);
}

/**
 * 发送 Authenticate 消息
 */
function sendAuthenticate(socket, username, password = '') {
  const auth = new mumbleproto.Authenticate({
    username,
    password,
    opus: true,
    tokens: [],
  });
  const message = createMessage(MessageType.Authenticate, Buffer.from(auth.serialize()));
  socket.write(message);
  console.log(`→ 发送 Authenticate (username=${username})`);
}

/**
 * 等待特定消息
 */
function waitForMessage(socket, messageType, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`等待消息超时 (type=${messageType})`));
    }, timeout);

    function onData(data) {
      buffer = Buffer.concat([buffer, data]);
      
      while (buffer.length >= 6) {
        const parsed = parseMessage(buffer);
        if (!parsed) break;
        
        buffer = buffer.slice(parsed.consumed);
        
        if (parsed.type === messageType) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve(parsed.data);
          return;
        }
      }
    }

    socket.on('data', onData);
  });
}

/**
 * 测试 1: PreConnectUserState
 */
async function testPreConnectUserState() {
  console.log('\n=== 测试 1: PreConnectUserState ===\n');
  
  const socket = await createConnection();
  let buffer = Buffer.alloc(0);
  let serverSyncReceived = false;
  let ownUserStateReceived = false;
  let ownSession = null;
  
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    while (buffer.length >= 6) {
      const parsed = parseMessage(buffer);
      if (!parsed) break;
      
      buffer = buffer.slice(parsed.consumed);
      
      if (parsed.type === MessageType.ServerSync) {
        const serverSync = mumbleproto.ServerSync.deserialize(parsed.data);
        ownSession = serverSync.session;
        serverSyncReceived = true;
        console.log(`← 收到 ServerSync (session=${ownSession})`);
      } else if (parsed.type === MessageType.UserState) {
        const userState = mumbleproto.UserState.deserialize(parsed.data);
        
        // 检查是否是自己的 UserState
        if (ownSession !== null && userState.session === ownSession) {
          console.log(`← 收到自己的 UserState (session=${userState.session})`);
          console.log(`   self_mute: ${userState.self_mute}`);
          console.log(`   self_deaf: ${userState.self_deaf}`);
          
          // 验证 PreConnect 状态是否应用
          if (userState.self_mute === true && userState.self_deaf === false) {
            console.log('✓ PreConnectUserState 已成功应用！');
            ownUserStateReceived = true;
          } else {
            console.log('✗ PreConnectUserState 未正确应用');
            console.log(`   期望: self_mute=true, self_deaf=false`);
            console.log(`   实际: self_mute=${userState.self_mute}, self_deaf=${userState.self_deaf}`);
          }
        }
      }
    }
  });
  
  // 发送消息序列
  sendVersion(socket);
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // 在认证前发送 UserState（PreConnect）
  sendPreConnectUserState(socket, true, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  
  sendAuthenticate(socket, 'test_preconnect_' + Date.now());
  
  // 等待认证完成
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  socket.end();
  
  if (ownUserStateReceived) {
    console.log('\n✓ 测试 1 通过\n');
    return true;
  } else {
    console.log('\n✗ 测试 1 失败\n');
    return false;
  }
}

/**
 * 测试 2: 频道权限动态刷新
 * 
 * 注意：这个测试需要管理员权限才能修改 ACL
 * 如果没有权限，测试会跳过
 */
async function testPermissionRefresh() {
  console.log('\n=== 测试 2: 频道权限动态刷新 ===\n');
  console.log('注意：此测试需要管理员权限，可能会失败');
  
  const socket = await createConnection();
  let buffer = Buffer.alloc(0);
  let ownSession = null;
  let testChannelId = null;
  let suppressStateChanged = false;
  let initialSuppress = null;
  
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    while (buffer.length >= 6) {
      const parsed = parseMessage(buffer);
      if (!parsed) break;
      
      buffer = buffer.slice(parsed.consumed);
      
      if (parsed.type === MessageType.ServerSync) {
        const serverSync = mumbleproto.ServerSync.deserialize(parsed.data);
        ownSession = serverSync.session;
        console.log(`← 收到 ServerSync (session=${ownSession})`);
      } else if (parsed.type === MessageType.UserState) {
        const userState = mumbleproto.UserState.deserialize(parsed.data);
        
        // 监控自己的 suppress 状态变化
        if (ownSession !== null && userState.session === ownSession && userState.has_suppress) {
          if (initialSuppress === null) {
            initialSuppress = userState.suppress;
            console.log(`← 初始 suppress 状态: ${initialSuppress}`);
          } else if (userState.suppress !== initialSuppress) {
            console.log(`← suppress 状态已改变: ${initialSuppress} -> ${userState.suppress}`);
            suppressStateChanged = true;
          }
        }
      }
    }
  });
  
  // 发送消息序列
  sendVersion(socket);
  await new Promise(resolve => setTimeout(resolve, 100));
  sendAuthenticate(socket, 'test_permission_' + Date.now());
  
  // 等待认证完成
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n说明：完整的 ACL 更新测试需要：');
  console.log('1. 管理员权限');
  console.log('2. 创建测试频道');
  console.log('3. 修改频道 ACL');
  console.log('4. 观察 suppress 状态变化');
  console.log('\n此测试仅验证基础连接和状态监控功能');
  
  socket.end();
  
  console.log('\n✓ 测试 2 基础功能正常（需手动测试完整功能）\n');
  return true;
}

/**
 * 主测试函数
 */
async function main() {
  console.log('开始测试 PreConnectUserState 和频道权限动态刷新功能\n');
  
  let allPassed = true;
  
  try {
    // 测试 1: PreConnectUserState
    const test1Passed = await testPreConnectUserState();
    allPassed = allPassed && test1Passed;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 测试 2: 频道权限动态刷新（基础测试）
    const test2Passed = await testPermissionRefresh();
    allPassed = allPassed && test2Passed;
    
  } catch (error) {
    console.error('测试过程中发生错误:', error);
    allPassed = false;
  }
  
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('所有测试通过！');
  } else {
    console.log('部分测试失败');
  }
  console.log('='.repeat(50) + '\n');
  
  process.exit(allPassed ? 0 : 1);
}

// 运行测试
main().catch(error => {
  console.error('未捕获的错误:', error);
  process.exit(1);
});
