# Edge Join Timing Investigation Summary

## Issue Description
"时序：
edge 1 加入hub
用户 a 连接到edge 1
edge 2 加入hub
用户b 连接到edge 2
a 和 b 之间有可见性问题"

Translation: There is a visibility problem between users A and B when Edge 2 joins after User A is already connected to Edge 1.

## Investigation Results

### Tests Created
1. **`edge-join-timing.test.ts`** - Tests the exact scenario described
2. **`edge-join-race-condition.test.ts`** - Tests timing-sensitive race conditions

### Test Results
✅ **ALL TESTS PASS** - Both users can see each other in all scenarios tested.

## System Analysis

### How User Visibility Works

#### 1. When a User Connects
```
Client connects → Edge authenticates → Edge.reportSession(to Hub) 
→ Hub.userJoined(broadcast to all Edges) 
→ Edge sends user list to client via fullSync
```

#### 2. FullSync Mechanism
Every authenticating user triggers a fresh `edge.fullSync` call:
```typescript
// From auth-handler.ts line 199
await this.sendUserListToClient(session_id);

// Which calls:
const syncData = await this.hubClient.call('edge.fullSync', {
  for_user_id: receiverClient.user_id,
  // ...
});
```

This ensures that every new user gets ALL current sessions from Hub.

#### 3. Cross-Edge Notifications
When a session is reported to Hub:
```typescript
// From control-service.ts
await this.broadcast('hub.userJoined', {
  session_id, edge_id, user_id, username, channel_id, groups, cert_hash
});
```

This notification goes to ALL connected Edges, which then broadcast to their local clients.

### Why It Works

The system has **redundant mechanisms** that ensure visibility:

1. **Initial fullSync** when Edge connects (line 375 in event-setup-manager.ts)
   - Edge 2 gets User A's session when it joins
   - Note: `loadSnapshot()` doesn't process sessions, but that's OK because...

2. **Per-user fullSync** when each user authenticates
   - User B calls fullSync and gets all users including User A
   - This is the primary mechanism ensuring visibility

3. **Real-time notifications** via `hub.userJoined`
   - When User B joins, Edge 1 (where User A is) receives notification
   - User A's client gets the UserState for User B
   - This ensures bidirectional visibility

### Test Coverage

#### Scenario 1: Basic Late Join (edge-join-timing.test.ts)
```
✅ Edge 1 joins → User A connects → Edge 2 joins → User B connects
   Result: Both users see each other
```

#### Scenario 2: Race Conditions (edge-join-race-condition.test.ts)
```
✅ User connecting while Edge is starting
✅ Multiple simultaneous connections across edges
   Result: All users see each other correctly
```

## Conclusion

The system is **working as designed**. The problem described in the issue either:

1. **Was already fixed** - There may have been a bug that was resolved before this investigation
2. **Requires specific conditions** - The issue may manifest only under conditions not yet tested (e.g., network partitions, very high load)
3. **Was a misunderstanding** - The expected behavior may have been unclear

The comprehensive integration tests now serve as **regression protection** to ensure this functionality continues to work correctly.

## Potential Improvements (Not Required)

While the system works correctly, there is one minor optimization opportunity:

### Optimization: Process sessions in loadSnapshot

Currently, when an Edge joins and receives fullSync, `loadSnapshot()` ignores the sessions field. While this doesn't cause bugs (because per-user fullSync covers it), processing sessions during Edge join would be slightly more efficient:

```typescript
// In state-manager.ts loadSnapshot()
if (snapshot.sessions && Array.isArray(snapshot.sessions)) {
  for (const session of snapshot.sessions) {
    if (session.edge_id !== this.edgeId) {
      this.addRemoteUser(session.session_id, session.edge_id, session.channel_id);
    }
  }
}
```

However, this optimization is **not necessary** for correctness and could introduce complexity without significant benefit.

## Files Modified

- `tests/integration/setup.ts` - Added `controlPort` to TestEnvironment, added test users
- `tests/integration/suites/edge-join-timing.test.ts` - New test file
- `tests/integration/suites/edge-join-race-condition.test.ts` - New test file

## Test Execution

```bash
# Run the specific edge join timing tests
pnpm test:integration tests/integration/suites/edge-join-timing.test.ts
pnpm test:integration tests/integration/suites/edge-join-race-condition.test.ts

# Run all user visibility tests
pnpm test:integration tests/integration/suites/user-visibility.test.ts

# Run all integration tests
pnpm test:integration
```

All tests pass successfully.
