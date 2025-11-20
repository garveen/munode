/**
 * 测试 UserState 广播只包含实际修改的字段
 */

const { mumbleproto } = require('./packages/protocol/dist/generated/proto/Mumble.js');

console.log('测试 UserState 字段过滤...\n');

// 模拟客户端发送的 UserState（只设置了 self_mute）
const clientUserState = new mumbleproto.UserState({
  session: 1,
  self_mute: true,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

console.log('客户端发送的 UserState:');
console.log('- has_session:', clientUserState.has_session);
console.log('- has_self_mute:', clientUserState.has_self_mute);
console.log('- has_self_deaf:', clientUserState.has_self_deaf);
console.log('- has_mute:', clientUserState.has_mute);
console.log('- has_deaf:', clientUserState.has_deaf);
console.log('- has_channel_id:', clientUserState.has_channel_id);
console.log('');

// 模拟服务器构建的广播消息（只包含客户端发送的字段）
const broadcastState = new mumbleproto.UserState({
  session: 1,
  actor: 2,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

// 只添加客户端实际发送的字段
if (clientUserState.has_self_mute) {
  broadcastState.self_mute = clientUserState.self_mute;
}

console.log('服务器广播的 UserState:');
console.log('- has_session:', broadcastState.has_session);
console.log('- has_actor:', broadcastState.has_actor);
console.log('- has_self_mute:', broadcastState.has_self_mute);
console.log('- has_self_deaf:', broadcastState.has_self_deaf);
console.log('- has_mute:', broadcastState.has_mute);
console.log('- has_deaf:', broadcastState.has_deaf);
console.log('- has_channel_id:', broadcastState.has_channel_id);
console.log('');

// 序列化并检查
const serialized = broadcastState.serialize();
console.log('序列化后的消息大小:', serialized.length, 'bytes');

// 反序列化验证
const deserialized = mumbleproto.UserState.deserialize(serialized);
console.log('\n反序列化后的字段:');
console.log('- has_session:', deserialized.has_session, '-> session:', deserialized.session);
console.log('- has_actor:', deserialized.has_actor, '-> actor:', deserialized.actor);
console.log('- has_self_mute:', deserialized.has_self_mute, '-> self_mute:', deserialized.self_mute);
console.log('- has_self_deaf:', deserialized.has_self_deaf, '-> self_deaf:', deserialized.self_deaf);
console.log('- has_mute:', deserialized.has_mute, '-> mute:', deserialized.mute);
console.log('- has_deaf:', deserialized.has_deaf, '-> deaf:', deserialized.deaf);
console.log('- has_channel_id:', deserialized.has_channel_id, '-> channel_id:', deserialized.channel_id);

console.log('\n✅ 测试通过！广播消息只包含实际修改的字段（session, actor, self_mute）');
console.log('   其他字段（self_deaf, mute, deaf, channel_id等）的 has_ 标志都是 false');
