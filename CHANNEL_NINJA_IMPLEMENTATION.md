# Channel Ninja Feature Implementation

## Overview

The Channel Ninja feature allows servers to hide channels from users who don't have permission to enter or listen to them. When enabled, users will only see channels in the channel tree that they can access (either directly or through linked channels).

## Configuration

### Hub Configuration

Add the following option to your Hub configuration file (e.g., `config/hub.json`):

```json
{
  "channelNinja": false
}
```

- **Default**: `false` (disabled)
- **When disabled**: All users can see all channels (traditional Mumble behavior)
- **When enabled**: Users only see channels they have permission to access

## How It Works

### Visibility Rules

A channel is visible to a user if **any** of the following conditions are met:

1. The user has **Enter** permission on the channel
2. The user has **Listen** permission on the channel
3. The user has **Enter or Listen** permission on **any linked channel**

### User State Broadcasting

When Channel Ninja is enabled:

1. **Normal state changes** (mute, deaf, etc.):
   - Only broadcast to users who can see the user's current channel
   - Users who cannot see the channel don't receive the state update

2. **Channel moves**:
   - If user moves to a **visible channel**: Normal UserState broadcast to all who can see it
   - If user moves to an **invisible channel**: 
     - Send `UserRemove` message to users who cannot see the new channel
     - User appears to have "left the server" to those who can't see them
     - Send `UserState` only to users who can see the new channel

3. **Returning to visible channel**:
   - When user moves back to a visible channel, normal UserState is sent
   - User "reappears" to those who previously couldn't see them

### Voice Routing

**Important**: Voice packets are **not affected** by Channel Ninja settings. Voice routing continues to work normally based on:
- Channel membership
- Listening channels
- Voice targets

This means:
- A user in an invisible channel can still be heard by others if voice routing allows it
- Voice targets and listening channels work independently of visibility

## Architecture

### Hub Server Changes

**Files Modified:**
- `packages/hub-server/src/types.ts` - Added `channelNinja` config option
- `packages/hub-server/src/config-defaults.ts` - Added default value
- `packages/hub-server/src/permission-checker.ts` - Added `canUserSeeChannel()` method
- `packages/hub-server/src/control-service.ts` - Modified UserState broadcast logic

**Key Implementation:**

```typescript
// Check if user can see a channel
async canUserSeeChannel(channelId: number, user: UserInfo): Promise<boolean> {
  // Check Enter/Listen on channel itself
  // Check Enter/Listen on linked channels
  // Return true if any permission found
}

// In handleUserStateNotification:
if (channelNinjaEnabled) {
  // For each user, check if they can see the channel
  // Send UserState only to users who can see
  // Send UserRemove to users who cannot see (on channel moves)
}
```

### Edge Server Changes

**Files Modified:**
- `packages/edge-server/src/cluster/hub-message-handler.ts`

**Key Changes:**
- Added support for `target_sessions` parameter in broadcast messages
- Filter broadcasts to only specified sessions
- Distinguish between ninja-mode UserRemove (don't disconnect) and kick/ban (do disconnect)

**Implementation:**

```typescript
// In handleUserStateBroadcastFromHub:
const targetSessions = params.target_sessions;
for (const client of allClients) {
  if (!targetSessions || targetSessions.includes(client.session)) {
    // Send UserState only to targeted sessions
  }
}

// In handleUserRemoveBroadcastFromHub:
if (!target_sessions) {
  // Real kick/ban - disconnect the user
} else {
  // Ninja mode - just send UserRemove, don't disconnect
}
```

## Testing

Comprehensive integration tests are provided in:
- `tests/integration/suites/channel-ninja.test.ts`

**Test Coverage:**
1. Basic ninja functionality (hiding users in invisible channels)
2. Cross-edge ninja functionality (hiding across multiple Edge servers)
3. State change filtering for users in invisible channels
4. Ninja disabled behavior verification

**Running Tests:**

```bash
# Run all integration tests
pnpm test:integration

# Run only channel ninja tests
pnpm test:integration tests/integration/suites/channel-ninja.test.ts
```

## Use Cases

### 1. Private Staff Channels

Create admin-only channels that regular users cannot see in the channel tree.

**Setup:**
1. Enable `channelNinja: true` in Hub config
2. Create a "Staff" channel
3. Set ACL to only allow "admin" group Enter/Listen permissions
4. Regular users won't see the channel or know when staff are in it

### 2. Hidden Meeting Rooms

Create temporary meeting channels that only participants can see.

**Setup:**
1. Enable Channel Ninja
2. Create temporary channels with restricted permissions
3. Only invited users (via group membership) can see and enter
4. Channel appears empty/hidden to non-participants

### 3. Graduated Access

Create a channel hierarchy where users gain visibility as they progress.

**Setup:**
1. Enable Channel Ninja
2. Create nested channels with increasing permission requirements
3. New users only see basic channels
4. As they gain permissions, more channels become visible

## Limitations and Considerations

1. **Voice Still Works**: Users can still hear each other through listening channels and voice targets, even if they can't see each other's channels.

2. **Performance**: Visibility checks happen for every UserState broadcast when ninja is enabled. For very large servers (100+ concurrent users), this may add some overhead.

3. **Linked Channels**: If a channel is linked to a visible channel, it becomes visible. Consider link relationships when designing channel permissions.

4. **Client Behavior**: Clients will see users "disconnect" and "reconnect" as they move between visible and invisible channels. This is expected behavior.

5. **ACL Required**: This feature requires properly configured ACLs. Without ACL restrictions, all channels are visible to all users (default behavior).

## Migration Guide

### Enabling on Existing Server

1. **Backup your database** and configuration
2. Review your channel ACL configurations
3. Add `"channelNinja": true` to Hub config
4. Restart Hub server
5. Test with a test user to verify behavior
6. Monitor logs for any issues

### Disabling if Needed

1. Set `"channelNinja": false` in Hub config
2. Restart Hub server
3. All channels become visible again (traditional behavior)

## Debugging

### Enable Debug Logging

```json
{
  "logLevel": "debug"
}
```

### Look for These Log Messages

Hub server logs:
```
Channel Ninja: Sending UserRemove for session X to Y users who cannot see channel Z
Channel Ninja: Broadcasting UserState for session X to Y users who can see channel Z
```

Edge server logs:
```
Broadcasted UserState to N local clients (filtered)
Broadcasted UserRemove to N local clients (filtered)
```

### Common Issues

1. **All channels still visible**: Check that `channelNinja` is set to `true` in Hub config and Hub has been restarted
2. **Users disappearing unexpectedly**: Review ACL permissions on channels - ensure permissions are set as intended
3. **Voice not working**: Voice routing is independent of ninja mode - check voice targets and listening channels

## Security Considerations

1. **Metadata Leakage**: While users can't see channels, they might infer their existence through other means (e.g., voice packets, user counts)
2. **Voice is Not Hidden**: Voice packets continue to route normally. If you need to hide voice as well, configure listening channels and voice targets appropriately.
3. **Linked Channels**: Be careful with channel links as they can make "hidden" channels visible

## Future Enhancements

Potential improvements for future versions:

1. Cache visibility calculations for better performance
2. Add option to also filter voice packets based on visibility
3. Add admin override to see all channels
4. Add channel visibility status indicator in client UI
5. Add visibility change notifications to channel owners

## Related Documentation

- [Mumble Protocol Documentation](https://mumble-protocol.readthedocs.io/)
- [ACL Configuration Guide](docs/ACL_CONFIGURATION.md)
- [Permission System Overview](docs/PERMISSIONS.md)
