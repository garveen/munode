/**
 * 测试监听频道功能 (ListenChannel)
 * 
 * 此测试演示了 MuNode 实现的监听频道功能，允许用户在不移动到目标频道的情况下
 * 监听其他频道的音频。
 * 
 * 功能说明:
 * 1. 用户可以通过发送 UserState 消息添加/移除监听频道
 * 2. 添加监听频道时需要检查 Listen 权限 (0x800)
 * 3. 语音路由器会将频道音频转发给所有监听该频道的用户
 * 4. Hub 负责权限检查和状态同步
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// 模拟 Mumble 客户端连接
class MumbleClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.session = null;
    this.authenticated = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`连接到服务器 ${this.host}:${this.port}...`);
      
      // 创建 TLS 连接（Mumble 使用 TLS）
      this.socket = tls.connect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: false, // 测试环境忽略证书验证
      }, () => {
        console.log('TLS 连接已建立');
        resolve();
      });

      this.socket.on('error', (err) => {
        console.error('连接错误:', err);
        reject(err);
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        console.log('连接已关闭');
      });
    });
  }

  handleData(data) {
    // 简化的 Mumble 协议解析
    // 实际实现需要处理 Protocol Buffers 消息
    console.log('收到服务器数据:', data.length, '字节');
  }

  // 发送 UserState 消息添加监听频道
  addListeningChannel(channelId) {
    console.log(`\n[示例] 添加监听频道 ${channelId}`);
    console.log('发送 UserState 消息:');
    console.log('  - listening_channel_add: [' + channelId + ']');
    console.log('  - session: ' + this.session);
    
    // 实际实现需要序列化 Protocol Buffers 消息
    // const userState = new mumbleproto.UserState({
    //   session: this.session,
    //   listening_channel_add: [channelId]
    // });
    // this.sendMessage(MessageType.UserState, userState.serialize());
    
    console.log('\n服务器处理流程:');
    console.log('1. Edge 服务器接收 UserState 消息');
    console.log('2. Edge 转发到 Hub: hub.handleUserState');
    console.log('3. Hub 检查 Listen 权限 (0x800)');
    console.log('4. Hub 广播 UserState 到所有 Edge');
    console.log('5. Edge 更新 client.listeningChannels');
    console.log('6. Voice Router 开始转发该频道音频');
  }

  // 发送 UserState 消息移除监听频道
  removeListeningChannel(channelId) {
    console.log(`\n[示例] 移除监听频道 ${channelId}`);
    console.log('发送 UserState 消息:');
    console.log('  - listening_channel_remove: [' + channelId + ']');
    console.log('  - session: ' + this.session);
    
    console.log('\n服务器处理流程:');
    console.log('1. Edge 服务器接收 UserState 消息');
    console.log('2. Edge 转发到 Hub (无需权限检查)');
    console.log('3. Hub 广播 UserState 到所有 Edge');
    console.log('4. Edge 从 client.listeningChannels 移除');
    console.log('5. Voice Router 停止转发该频道音频');
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
    }
  }
}

// 主测试函数
async function testListenChannel() {
  console.log('='.repeat(70));
  console.log('MuNode 监听频道功能测试');
  console.log('='.repeat(70));
  console.log();

  console.log('功能概述:');
  console.log('- 用户可以监听其他频道而不移动到该频道');
  console.log('- 需要目标频道的 Listen 权限 (0x800)');
  console.log('- 语音包会自动转发给监听者');
  console.log();

  console.log('实现位置:');
  console.log('1. types.ts: ClientInfo.listeningChannels: Set<number>');
  console.log('2. edge-server.ts: handleUserState() 处理 listening_channel_add/remove');
  console.log('3. voice-router.ts: routeToChannel() 转发给监听者');
  console.log('4. control-service.ts: Hub 权限检查和状态同步');
  console.log('5. permission.ts: Permission.Listen = 0x800');
  console.log();

  console.log('使用场景:');
  console.log('场景 1: 管理员监听多个频道');
  console.log('  - 管理员在根频道');
  console.log('  - 添加监听 "会议室1" 和 "会议室2"');
  console.log('  - 可以同时听到两个会议室的讨论');
  console.log();

  console.log('场景 2: 跨频道协作');
  console.log('  - 用户 A 在 "开发组" 频道');
  console.log('  - 用户 B 在 "测试组" 频道');
  console.log('  - A 添加监听 "测试组"');
  console.log('  - A 可以听到 B 的语音，但 A 仍在 "开发组"');
  console.log();

  console.log('场景 3: 讲座/演示模式');
  console.log('  - 演讲者在 "演讲厅" 频道');
  console.log('  - 多个小组频道的成员监听 "演讲厅"');
  console.log('  - 所有人都能听到演讲者，但保持在各自频道讨论');
  console.log();

  console.log('='.repeat(70));
  console.log('协议消息示例');
  console.log('='.repeat(70));
  console.log();

  // 模拟客户端操作
  const client = new MumbleClient('localhost', 64738);
  client.session = 1; // 假设已认证

  // 示例 1: 添加监听频道
  client.addListeningChannel(2);
  
  // 示例 2: 移除监听频道
  client.removeListeningChannel(2);

  console.log();
  console.log('='.repeat(70));
  console.log('权限检查逻辑');
  console.log('='.repeat(70));
  console.log();
  
  console.log('添加监听频道时:');
  console.log('```typescript');
  console.log('if (userStateObj.listening_channel_add) {');
  console.log('  for (const channelId of userStateObj.listening_channel_add) {');
  console.log('    // 检查 Listen 权限');
  console.log('    const hasListen = await permissionChecker.hasPermission(');
  console.log('      channelId,');
  console.log('      actorUserInfo,');
  console.log('      Permission.Listen  // 0x800');
  console.log('    );');
  console.log('    ');
  console.log('    if (hasListen) {');
  console.log('      // 允许监听');
  console.log('      client.listeningChannels.add(channelId);');
  console.log('    } else {');
  console.log('      // 拒绝并发送 PermissionDenied');
  console.log('      sendPermissionDenied(session, channelId, "Listen");');
  console.log('    }');
  console.log('  }');
  console.log('}');
  console.log('```');
  console.log();

  console.log('语音路由逻辑:');
  console.log('```typescript');
  console.log('// routeToChannel() 中');
  console.log('// 1. 发送给频道内的用户');
  console.log('for (const client of channelClients) {');
  console.log('  sendVoicePacket(client, voiceData);');
  console.log('}');
  console.log();
  console.log('// 2. 发送给监听此频道的用户');
  console.log('for (const client of allClients) {');
  console.log('  if (client.listeningChannels.has(sourceChannelId)) {');
  console.log('    sendVoicePacket(client, voiceData);');
  console.log('  }');
  console.log('}');
  console.log('```');
  console.log();

  console.log('='.repeat(70));
  console.log('测试完成');
  console.log('='.repeat(70));
  console.log();
  console.log('要测试实际功能，请:');
  console.log('1. 启动 Hub 服务器: cd packages/hub-server && pnpm start');
  console.log('2. 启动 Edge 服务器: cd packages/edge-server && pnpm start');
  console.log('3. 使用 Mumble 客户端连接并测试监听频道功能');
  console.log();
  console.log('客户端操作:');
  console.log('1. 右键点击用户 -> "监听" -> 选择频道');
  console.log('2. 查看用户状态，应显示正在监听的频道');
  console.log('3. 该频道的音频会转发给该用户');
  console.log();
}

// 运行测试
testListenChannel().catch(console.error);
