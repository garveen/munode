# TCP Voice Functionality Fix

## Problem Description

TCP voice functionality was not working properly because test code was sending improperly formatted voice packets. Voice packets were failing to parse on the server side and being silently dropped, preventing proper TCP voice transmission and reception.

## Root Cause Analysis

The issue was identified in the test code that sends voice packets via TCP tunnel. The tests were sending raw string buffers:

```typescript
// INCORRECT - Before fix
const mockVoiceData = Buffer.from('mock_voice_data_for_testing');
await sender.getConnectionManager().sendVoicePacket(mockVoiceData);
```

However, according to the Mumble protocol specification, voice packets must follow a specific format:

### Mumble Voice Packet Format

```
Byte 0: Header
  - Bits 7-5: Codec type (3 bits)
    * 0 = CELT Alpha
    * 1 = Ping  
    * 2 = Speex
    * 3 = CELT Beta
    * 4 = Opus
  - Bits 4-0: Target (5 bits)
    * 0 = Normal channel (Push-to-Talk)
    * 1-30 = VoiceTarget ID (Whisper)
    * 31 = Server loopback

Byte 1+: Varint encoded sequence number
Byte N+: Actual voice data payload
```

### Parsing Logic

The server's `parseVoicePacket()` method in `voice-router.ts` expects this format:

```typescript
private parseVoicePacket(data: Buffer): VoicePacket | null {
  if (data.length < 2) {
    return null; // Packet too small - REJECT
  }

  const header = data.readUInt8(0);
  const type = (header >> 5) & 0x07; // Extract codec type
  const target = header & 0x1f;      // Extract target
  
  // Validate type
  if (type === 1) return null;  // Ping packet
  if (type > 4) {
    this.logger.warn(`Unsupported voice packet type: ${type}`);
    return null; // Invalid codec - REJECT
  }
  
  // Rest of packet is sequence + voice data
  const payload = data.slice(1);
  // ...
}
```

When tests sent raw string data like `Buffer.from('mock_voice_data_for_testing')`:
- The first byte 'm' (0x6D = 109 decimal = 0b1101101) would be interpreted as:
  - Codec type: (109 >> 5) & 0x07 = 3 (CELT Beta)
  - Target: 109 & 0x1F = 13 (VoiceTarget 13)
- This might pass initial validation, but the remaining bytes wouldn't be a valid varint sequence number, causing issues in routing logic

## Solution

Updated all TCP voice tests to use the `createVoicePacket()` helper function from `tests/integration/utils/test-helpers.ts`:

```typescript
// CORRECT - After fix
import { createVoicePacket } from '../utils/test-helpers.js';

const voicePacket = createVoicePacket(4, 0, 1); // Opus codec, normal channel, sequence=1
await sender.getConnectionManager().sendVoicePacket(voicePacket);
```

The `createVoicePacket()` function creates properly formatted packets:

```typescript
export function createVoicePacket(
  codec: number = 4,      // 4 = Opus (most common)
  target: number = 0,     // 0 = normal channel
  sequence: number = 0    // sequence number
): Buffer {
  // Create header: (codec << 5) | (target & 0x1F)
  const header = Buffer.alloc(1);
  header.writeUInt8((codec << 5) | (target & 0x1F), 0);
  
  // Simple varint encoding for small sequence numbers
  const sequenceVarint = Buffer.from([sequence & 0x7F]);
  
  // Generate random voice data
  const voiceData = generateRandomVoiceData(20);
  
  // Concatenate: [header][sequence][voice_data]
  return Buffer.concat([header, sequenceVarint, voiceData]);
}
```

## TCP Voice Flow

### Client Side (Sending)

1. **Create voice packet** with proper format (header + sequence + data)
2. **Encrypt** with OCB2-AES128: `crypto.encrypt(voicePacket)`
3. **Wrap in UDPTunnel message**: `wrapMessage(MessageType.UDPTunnel, encrypted)`
4. **Send via TCP** connection

```typescript
// From packages/client/src/core/connection.ts
async sendVoicePacket(packet: Buffer): Promise<void> {
  // 1. Encrypt voice packet
  let encryptedPacket = packet;
  if (this.client.getCryptoManager().isInitialized()) {
    encryptedPacket = this.client.getCryptoManager().encrypt(packet);
  }

  if (this.isUsingTcpVoice()) {
    // 2-4. Wrap and send via TCP
    return this.sendTCPVoicePacket(encryptedPacket);
  }
  // ... UDP handling
}

async sendTCPVoicePacket(packet: Buffer): Promise<void> {
  // Wrap in UDPTunnel message (MessageType = 1)
  const message = this.wrapMessage(MessageType.UDPTunnel, packet);
  return this.sendTCP(message);
}
```

### Server Side (Receiving)

1. **Receive UDPTunnel message** via TCP
2. **Decrypt** voice packet: `crypto.decrypt(data)`
3. **Parse** voice packet to extract header, target, sequence
4. **Route** to appropriate recipients based on target

```typescript
// From packages/edge-server/src/voice/voice-router.ts
handleVoiceTunnel(session_id: number, data: Buffer): void {
  // 1. Decrypt
  const crypto = this.clientCryptos.get(session_id);
  const decrypted = crypto.decrypt(data);
  const voicePacketData = decrypted.data;
  
  // 2. Parse
  const packet = this.parseVoicePacket(voicePacketData);
  packet.sender_session = session_id;
  
  // 3. Route based on target
  this.routeVoicePacket(packet);
}
```

### Server Side (Forwarding to Recipients)

1. **Serialize** voice packet (add sender session ID)
2. **Encrypt** with recipient's OCB2-AES128 key
3. **Send via TCP or UDP** depending on recipient's connection

```typescript
// TCP recipient
private sendVoicePacketViaTCP(client: ClientInfo, voiceData: Buffer): void {
  const crypto = this.clientCryptos.get(client.session);
  const encrypted = crypto.encrypt(voiceData);
  
  // Emit event to send UDPTunnel message
  this.emit('sendTCPVoicePacket', client.session, encrypted);
}
```

## Verification

After the fix, voice packets are successfully processed:

```
[ConnectionManager] sendVoicePacket: size=22, isUsingTcpVoice=true
[ConnectionManager] Voice packet encrypted: 22 -> 26 bytes
[ConnectionManager] Using TCP tunnel for voice
[ConnectionManager] sendTCPVoicePacket: wrapping 26 bytes as UDPTunnel message
[ConnectionManager] sendTCPVoicePacket: sending 32 bytes via TCP
Processed voice packet from session 1, sequence 1
```

### Test Results

All 11 TCP voice integration tests pass:

1. ✅ Should connect with forceTcpVoice option
2. ✅ Should send voice packets via TCP tunnel
3. ✅ Should automatically fallback to TCP when UDP fails
4. ✅ Should handle voice routing in mixed environment (TCP + UDP)
5. ✅ Should route TCP voice packets to UDP clients
6. ✅ Should route UDP voice packets to TCP clients
7. ✅ Should construct valid voice packets for TCP transmission
8. ✅ Should handle voice packets with random payload
9. ✅ Should route TCP voice packets across edges
10. ✅ Should handle rapid voice packet transmission (20 packets)
11. ✅ Should handle large voice packets (2048 bytes)

## Reference

This implementation follows the official Mumble protocol specification:
- **Official Mumble**: https://github.com/mumble-voip/mumble
- **Protocol Documentation**: `src/MumbleProtocol.h`
- **UDP Packet Format**: Used for both UDP and TCP (UDPTunnel) voice transmission

## Files Changed

1. **tests/integration/test-users.ts**
   - Added missing TCP voice test users (tcp_user, tcp_sender, tcp_receiver, etc.)

2. **tests/integration/suites/tcp-voice.test.ts**
   - Imported `createVoicePacket` helper
   - Updated all voice packet creation to use proper format
   - All 11 tests now create valid Mumble protocol voice packets

## Lessons Learned

1. **Always use protocol-compliant formats**: Test code must follow the same protocol specifications as production code
2. **Silent failures are problematic**: The voice packets were being silently dropped without clear error messages
3. **Helper functions exist for a reason**: The `createVoicePacket()` helper was already available but not being used consistently
4. **Proper testing validates real functionality**: Tests should actually verify packet reception, not just that sending doesn't throw errors

## Future Improvements

1. Add more descriptive error logging when voice packets fail to parse
2. Add validation tests that specifically check packet format compliance
3. Consider adding packet format validation in development mode
4. Document voice packet format requirements in test documentation
