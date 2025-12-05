# ACL Message Routing Issue Investigation

## Problem Summary
4 out of 13 ACL operation integration tests are failing with "ACL query timeout" errors. These tests time out when attempting to query ACL data after performing ACL modifications.

## Investigation Findings

### Test Results
- **Passing**: 9/13 tests (69%)
- **Failing**: 4/13 tests (31%)
  - "should remove ACL entry from channel"
  - "should create channel group"  
  - "should add user to channel group"
  - "should enforce speak permission"

### Root Cause Analysis

Through extensive debugging with console.error logs at multiple layers, I discovered:

1. **Client sends ACL messages correctly**: Log evidence shows the client's ACL manager successfully:
   - Creates ACL protobuf messages
   - Wraps them with message type 13 (MessageType.ACL)
   - Calls sendTCP() to write to the socket

2. **Edge server NEVER receives ACL messages**: Despite client sending, the Edge server's:
   - `parseAndHandleMessage()` never receives raw data with type 13
   - `handleMessage()` is never called with messageType 13
   - `handleACL()` is never invoked

3. **Hub server NEVER receives ACL requests**: The Hub's RPC handler:
   - `handleACLRequest()` is never called
   - No ACL forwarding occurs from Edge to Hub

4. **Yet some tests pass**: This paradox suggests:
   - Tests passing are querying channels that already have ACL data in memory
   - Or there's a race condition / caching issue
   - The "timeout" tests are the ones that create new channels and try to query them

### Message Flow Analysis

Expected flow:
```
Client -> [sendTCP] -> Edge Server -> [parseAndHandleMessage] -> [handleMessage] -> [handleACL] -> [Edge Permission Handler] -> [RPC call] -> Hub
```

Actual flow:
```
Client -> [sendTCP] -> ??? (messages disappear here)
```

### Possible Causes

1. **TCP Socket Issue**: ACL messages might not be written to the socket correctly
2. **Message Type Filtering**: Some layer might be filtering out message type 13
3. **Relay/Proxy Layer**: An intermediary might be intercepting/dropping ACL messages
4. **Test Environment Issue**: The test setup might have a mock or stub interfering
5. **Connection State**: ACL messages might only work in certain client states

### What Was Ruled Out

- ✅ Client state validation (isMessageAllowedInState returns true for Authenticated/Ready)
- ✅ Protobuf field checking (has_channel_id fixes were applied correctly)
- ✅ Edge->Hub RPC type definitions (param names are correct)
- ✅ Message handler switch statement (includes case for MessageType.ACL)

## Recommended Next Steps

1. **Reference Official Mumble Implementation**
   - Review https://github.com/mumble-voip/mumble for ACL message handling
   - Compare message flow and routing logic
   - Check if there are special requirements for ACL messages

2. **Investigate Client-Side Sending**
   - Add packet capture to verify TCP packets are actually sent
   - Check if wrapMessage() correctly formats ACL messages
   - Verify socket write completion

3. **Investigate Server-Side Receiving**
   - Add logging at TCP socket 'data' event handler
   - Check if Edge server's socket event handlers are properly set up
   - Verify no middleware is filtering messages

4. **Review Test Environment**
   - Check if test setup has any message interception
   - Verify Edge server process is actually running and listening
   - Ensure no proxy or tunnel is in the way

## Related Commits

- `44b1e07`: Fixed channel creation using has_channel_id
- `a594f67`: Fixed user disconnection param names
- `dbbd874`: Applied has_channel_id checks to ACL handlers

## Status

This issue requires deeper investigation into the message transport layer and is beyond the scope of simple protobuf field checking fixes.
