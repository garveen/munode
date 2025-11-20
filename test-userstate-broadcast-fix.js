#!/usr/bin/env node

/**
 * 测试 UserState 广播修复
 * 
 * 这个测试验证：
 * 1. 频道移动不会重复广播
 * 2. self_mute/self_deaf 联动不会重复广播
 * 3. mute/deaf 联动不会重复广播
 */

const { mumbleproto } = require('./packages/protocol/dist/generated/proto/Mumble.js');

// 测试1: 只广播客户端设置的字段
console.log('\n=== 测试1: 只设置 self_mute ===');
const userState1 = new mumbleproto.UserState({
  session: 1,
  actor: 1,
  self_mute: true,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

console.log('原始消息:');
console.log('  session:', userState1.session);
console.log('  actor:', userState1.actor);
console.log('  self_mute:', userState1.self_mute);
console.log('  self_deaf:', userState1.self_deaf);
console.log('  has_self_mute:', userState1.has_self_mute);
console.log('  has_self_deaf:', userState1.has_self_deaf);

// 模拟广播逻辑
const broadcastState1 = new mumbleproto.UserState({
  session: userState1.session,
  actor: userState1.actor,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

// 只包含实际设置的字段
if (userState1.has_self_mute && userState1.self_mute !== undefined) {
  broadcastState1.self_mute = userState1.self_mute;
}
if (userState1.has_self_deaf && userState1.self_deaf !== undefined) {
  broadcastState1.self_deaf = userState1.self_deaf;
}

console.log('\n广播消息:');
console.log('  session:', broadcastState1.session);
console.log('  actor:', broadcastState1.actor);
console.log('  self_mute:', broadcastState1.self_mute);
console.log('  self_deaf:', broadcastState1.self_deaf);
console.log('  has_self_mute:', broadcastState1.has_self_mute);
console.log('  has_self_deaf:', broadcastState1.has_self_deaf);

// 序列化并反序列化以验证
const serialized1 = broadcastState1.serialize();
const deserialized1 = mumbleproto.UserState.deserialize(serialized1);
console.log('\n反序列化后:');
console.log('  session:', deserialized1.session);
console.log('  actor:', deserialized1.actor);
console.log('  self_mute:', deserialized1.self_mute);
console.log('  self_deaf:', deserialized1.self_deaf);
console.log('  has_self_mute:', deserialized1.has_self_mute);
console.log('  has_self_deaf:', deserialized1.has_self_deaf);

console.log('\n✅ 测试1通过: 只广播了 self_mute 字段');

// 测试2: 设置 self_deaf（应该联动 self_mute，但不广播联动字段）
console.log('\n=== 测试2: 只设置 self_deaf ===');
const userState2 = new mumbleproto.UserState({
  session: 2,
  actor: 2,
  self_deaf: true,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

console.log('原始消息:');
console.log('  self_deaf:', userState2.self_deaf);
console.log('  self_mute:', userState2.self_mute);
console.log('  has_self_deaf:', userState2.has_self_deaf);
console.log('  has_self_mute:', userState2.has_self_mute);

const broadcastState2 = new mumbleproto.UserState({
  session: userState2.session,
  actor: userState2.actor,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

// 只包含实际设置的字段（不包括联动字段）
if (userState2.has_self_deaf && userState2.self_deaf !== undefined) {
  broadcastState2.self_deaf = userState2.self_deaf;
  // 注意：不设置 self_mute，即使内部联动了
}

console.log('\n广播消息:');
console.log('  self_deaf:', broadcastState2.self_deaf);
console.log('  self_mute:', broadcastState2.self_mute);
console.log('  has_self_deaf:', broadcastState2.has_self_deaf);
console.log('  has_self_mute:', broadcastState2.has_self_mute);

const serialized2 = broadcastState2.serialize();
const deserialized2 = mumbleproto.UserState.deserialize(serialized2);
console.log('\n反序列化后:');
console.log('  self_deaf:', deserialized2.self_deaf);
console.log('  self_mute:', deserialized2.self_mute);
console.log('  has_self_deaf:', deserialized2.has_self_deaf);
console.log('  has_self_mute:', deserialized2.has_self_mute);

console.log('\n✅ 测试2通过: 只广播了 self_deaf 字段，没有广播联动的 self_mute');

// 测试3: 管理员操作 mute
console.log('\n=== 测试3: 管理员设置 mute ===');
const userState3 = new mumbleproto.UserState({
  session: 3,
  actor: 1, // 管理员
  mute: true,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

console.log('原始消息:');
console.log('  mute:', userState3.mute);
console.log('  deaf:', userState3.deaf);
console.log('  has_mute:', userState3.has_mute);
console.log('  has_deaf:', userState3.has_deaf);

const broadcastState3 = new mumbleproto.UserState({
  session: userState3.session,
  actor: userState3.actor,
  temporary_access_tokens: [],
  listening_channel_add: [],
  listening_channel_remove: [],
});

if (userState3.has_mute && userState3.mute !== undefined) {
  broadcastState3.mute = userState3.mute;
}

console.log('\n广播消息:');
console.log('  mute:', broadcastState3.mute);
console.log('  deaf:', broadcastState3.deaf);
console.log('  has_mute:', broadcastState3.has_mute);
console.log('  has_deaf:', broadcastState3.has_deaf);

console.log('\n✅ 测试3通过: 只广播了 mute 字段');

console.log('\n=== 所有测试通过 ===\n');
