/**
 * 类型化 EventEmitter 测试
 */

import { TypedEventEmitter, type EventMap } from '@munode/common';

// 定义测试事件类型
interface TestEvents extends EventMap {
  'user-connected': [userId: number, username: string];
  'user-disconnected': [userId: number];
  'error': [error: Error];
  'data': [data: Buffer];
}

// 创建测试类
class TestEmitter extends TypedEventEmitter<TestEvents> {
  connect(userId: number, username: string) {
    this.emit('user-connected', userId, username); // ✅ 应该可以
  }

  disconnect(userId: number) {
    this.emit('user-disconnected', userId); // ✅ 应该可以
  }

  sendError(error: Error) {
    this.emit('error', error); // ✅ 应该可以
  }

  // 下面这些应该报错：
  // testWrongEvent() {
  //   this.emit('unknown-event', 123); // ❌ 编译错误：事件不存在
  // }

  // testWrongParams() {
  //   this.emit('user-connected', 'wrong'); // ❌ 编译错误：参数类型错误
  // }
}

// 测试监听器
const emitter = new TestEmitter();

emitter.on('user-connected', (userId, username) => {
  // userId 和 username 都有正确的类型
  console.log(`User ${userId} (${username}) connected`);
});

emitter.on('user-disconnected', (userId) => {
  console.log(`User ${userId} disconnected`);
});

emitter.on('error', (error) => {
  console.error('Error:', error.message);
});

// 测试触发事件
emitter.connect(1, 'Alice');
emitter.disconnect(1);
emitter.sendError(new Error('Test error'));

console.log('✅ 类型化 EventEmitter 测试通过！');
