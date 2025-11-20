# ListenChannel 广播修复

## 问题描述

客户端添加监听频道后，虽然 Hub 和 Edge 都正确处理了请求，但客户端没有看到监听效果。

## 根本原因

在 `handleUserStateBroadcastFromHub` 方法中，构造 UserState 消息时错误地初始化了空数组：

```typescript
const userState = new mumbleproto.UserState({
  session: userStateObj.session || session_id,
  actor: userStateObj.actor,
  temporary_access_tokens: [],
  listening_channel_add: [],      // ❌ 问题：空数组会被序列化
  listening_channel_remove: [],   // ❌ 问题：空数组会被序列化
});
```

**问题**：
- `listening_channel_add` 是 `repeated` 字段（不是 `optional`）
- 空数组会被序列化并发送给客户端
- 客户端可能将空数组解释为"清空监听列表"

## 修复方案

只在有实际值时才在初始化对象中包含这些字段：

```typescript
const userStateInit: any = {
  session: userStateObj.session || session_id,
  actor: userStateObj.actor,
};

// ✅ 只在有值时才添加 repeated 字段
if (userStateObj.listening_channel_add && userStateObj.listening_channel_add.length > 0) {
  userStateInit.listening_channel_add = userStateObj.listening_channel_add;
}
if (userStateObj.listening_channel_remove && userStateObj.listening_channel_remove.length > 0) {
  userStateInit.listening_channel_remove = userStateObj.listening_channel_remove;
}

const userState = new mumbleproto.UserState(userStateInit);
```

## 测试步骤

1. **启动服务器**
   ```bash
   pnpm run build
   # 启动 Hub 和 Edge 实例
   ```

2. **测试监听添加**
   - 用户 A 在频道 1
   - 用户 A 添加对频道 2 的监听
   - 检查客户端界面是否显示监听状态
   - 用户 B 在频道 2 说话
   - 验证用户 A 能听到

3. **测试监听移除**
   - 用户 A 移除对频道 2 的监听
   - 检查客户端界面监听状态消失
   - 验证用户 A 不再听到频道 2 的声音

## 预期日志

成功添加监听时应该看到：
```
[info] User admin started listening to channels: 2
[debug] Client admin now listening to channels: 2
[debug] Sent message: session=1, type=9, length=7
```

客户端应该收到包含 `listening_channel_add=[2]` 的 UserState 消息。

## 相关文件

- `packages/edge-server/src/edge-server.ts` - 广播处理
- `LISTEN_CHANNEL_IMPLEMENTATION.md` - 完整实现文档
