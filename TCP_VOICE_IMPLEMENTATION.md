# TCP Voice Transport Implementation

This document describes the TCP voice transport feature implementation in MuNode.

## Overview

MuNode now supports TCP voice transmission as an alternative to UDP, with automatic fallback when UDP connectivity fails. This is particularly useful for:

- Networks that block UDP traffic
- NAT traversal issues
- Testing environments without UDP support
- Firewall-restricted environments

## Features

### 1. Force TCP Voice Mode

Clients can explicitly request TCP-only voice transmission by setting the `forceTcpVoice` option:

```typescript
const client = new MumbleClient();
await client.connect({
  host: 'localhost',
  port: 64738,
  username: 'user',
  password: 'pass',
  forceTcpVoice: true  // Force TCP voice transmission
});
```

### 2. Automatic UDP Fallback

When `forceTcpVoice` is not set (or set to false), the client will attempt UDP voice transmission first. If UDP fails (e.g., socket error, send failure), it automatically falls back to TCP:

```typescript
const client = new MumbleClient();
await client.connect({
  host: 'localhost',
  port: 64738,
  username: 'user',
  password: 'pass',
  forceTcpVoice: false  // Try UDP, fallback to TCP if needed
});
```

### 3. Mixed UDP/TCP Environment

The edge server supports simultaneous UDP and TCP voice clients. Voice packets are automatically routed between clients regardless of their transport mode:

- TCP client → UDP client: Voice packets sent via TCP tunnel are decrypted and forwarded via UDP
- UDP client → TCP client: Voice packets received via UDP are encrypted and forwarded via TCP tunnel
- TCP client → TCP client: Voice packets stay in TCP tunnel format
- UDP client → UDP client: Voice packets use native UDP routing

## Implementation Details

### Client Side

#### ConnectOptions Interface

```typescript
export interface ConnectOptions {
  // ... other options ...
  
  /** Force TCP voice transmission (instead of UDP) */
  forceTcpVoice?: boolean;
}
```

#### ConnectionManager Methods

```typescript
class ConnectionManager {
  /**
   * Set force TCP voice mode
   */
  setForceTcpVoice(force: boolean): void;
  
  /**
   * Check if using TCP voice
   */
  isUsingTcpVoice(): boolean;
  
  /**
   * Send voice packet (automatically chooses UDP or TCP)
   */
  async sendVoicePacket(packet: Buffer): Promise<void>;
  
  /**
   * Send voice packet via TCP tunnel
   */
  async sendTCPVoicePacket(packet: Buffer): Promise<void>;
}
```

#### Automatic Fallback Logic

The client automatically detects UDP failures and switches to TCP:

1. UDP socket creation failure → immediate TCP mode
2. UDP send error → mark UDP as failed, use TCP for next packet
3. UDP socket error event → switch to TCP mode

### Edge Server Side

#### Voice Router Updates

The `VoiceRouter` class now handles both UDP and TCP voice packets:

```typescript
class VoiceRouter {
  /**
   * Handle TCP voice tunnel messages
   */
  handleVoiceTunnel(session_id: number, data: Buffer): void;
  
  /**
   * Send voice packet to client (automatically chooses UDP or TCP)
   */
  sendVoicePacketToClient(client: ClientInfo, voiceData: Buffer): void;
  
  /**
   * Send voice packet via UDP
   */
  private sendVoicePacketViaUDP(client: ClientInfo, voiceData: Buffer): void;
  
  /**
   * Send voice packet via TCP tunnel
   */
  private sendVoicePacketViaTCP(client: ClientInfo, voiceData: Buffer): void;
}
```

#### Event Wiring

The `EventSetupManager` connects TCP voice events:

```typescript
// Handle UDPTunnel messages (TCP voice packets)
this.handlerFactory.messageHandler.on('udpTunnel', (session_id: number, data: Buffer) => {
  this.handlerFactory.voiceRouter.handleVoiceTunnel(session_id, data);
});

// Send TCP voice packets to clients
this.handlerFactory.voiceRouter.on('sendTCPVoicePacket', (session_id: number, voiceData: Buffer) => {
  this.messageManager!.sendMessageToClient(session_id, MessageType.UDPTunnel, voiceData);
});
```

## Protocol Details

### TCP Voice Packet Format

TCP voice packets use the Mumble `UDPTunnel` message type (MessageType = 1):

```
[TCP Header: 6 bytes]
  - Type: 2 bytes (0x0001 for UDPTunnel)
  - Length: 4 bytes (payload length)
[TCP Payload: encrypted voice packet]
  - Encrypted using OCB2-AES128
  - Same format as UDP voice packets
```

### Voice Packet Structure

Both UDP and TCP use the same encrypted voice packet format:

```
[Encrypted Packet]
  [Header: 1 byte]
    - Codec: 3 bits (high)
    - Target: 5 bits (low)
  [Session ID: varint]
  [Sequence Number: varint]
  [Voice Data: variable]
```

## Testing

### Unit Test Verification

The implementation includes TypeScript type definitions that ensure:

1. `forceTcpVoice` option is properly typed in `ConnectOptions`
2. All TCP voice methods are properly typed in `ConnectionManager`
3. Build completes without errors

### Integration Tests

The `tests/integration/suites/tcp-voice.test.ts` file contains comprehensive tests:

1. **TCP-only Voice Mode**
   - Connect with forceTcpVoice option
   - Send voice packets via TCP tunnel
   
2. **UDP Fallback to TCP**
   - Automatic fallback when UDP fails
   
3. **Mixed TCP/UDP Environment**
   - Voice routing between TCP and UDP clients
   - TCP → UDP client transmission
   - UDP → TCP client transmission
   
4. **Voice Packet Format**
   - Valid voice packet construction
   - Random payload handling
   
5. **Cross-Edge TCP Voice**
   - TCP voice routing across edges
   
6. **TCP Voice Performance**
   - Rapid packet transmission
   - Large packet handling

### Running Tests

```bash
# Build the project
pnpm build

# Run all integration tests
pnpm test:integration

# Run only TCP voice tests
pnpm test:integration tests/integration/suites/tcp-voice.test.ts
```

## Usage Examples

### Example 1: Force TCP Voice

```typescript
import { MumbleClient } from '@munode/client';

const client = new MumbleClient();

// Connect with TCP-only voice
await client.connect({
  host: 'mumble.example.com',
  port: 64738,
  username: 'TcpUser',
  password: 'secure_password',
  forceTcpVoice: true
});

console.log('Using TCP voice:', client.getConnectionManager().isUsingTcpVoice());
// Output: Using TCP voice: true
```

### Example 2: Auto-Fallback

```typescript
import { MumbleClient } from '@munode/client';

const client = new MumbleClient();

// Connect without forcing TCP (will try UDP first)
await client.connect({
  host: 'mumble.example.com',
  port: 64738,
  username: 'AutoUser',
  password: 'secure_password'
});

// Check current mode
console.log('Using TCP voice:', client.getConnectionManager().isUsingTcpVoice());
// Output: Using TCP voice: false (if UDP works) or true (if UDP failed)
```

### Example 3: Manual Mode Control

```typescript
import { MumbleClient } from '@munode/client';

const client = new MumbleClient();

await client.connect({
  host: 'mumble.example.com',
  port: 64738,
  username: 'ControlUser',
  password: 'secure_password'
});

// Switch to TCP mode manually
client.getConnectionManager().setForceTcpVoice(true);
console.log('Switched to TCP voice');

// Send voice packet
const audioData = Buffer.from('...'); // Your encoded audio data
await client.getConnectionManager().sendVoicePacket(audioData);
```

## Command-Line Usage

For the command-line client, you can add a `--tcp-voice` flag:

```bash
# Connect using TCP voice only
munode-client connect --host mumble.example.com --username User --tcp-voice

# Normal connection (UDP with TCP fallback)
munode-client connect --host mumble.example.com --username User
```

## Performance Considerations

### TCP vs UDP Performance

- **UDP**: Lower latency, no overhead from TCP protocol, ideal for voice
- **TCP**: Higher latency due to TCP overhead and retransmissions, but more reliable

### When to Use TCP Voice

- **Network restrictions**: Firewalls blocking UDP
- **NAT issues**: Complex NAT setups where UDP punch-through fails
- **Testing**: Development/testing environments without UDP support
- **Reliability**: Situations where packet loss is unacceptable

### Recommendations

1. Always try UDP first (default behavior)
2. Let automatic fallback handle UDP failures
3. Only force TCP mode when you know UDP won't work
4. Monitor connection quality to adjust transport mode if needed

## Troubleshooting

### Issue: Voice not working in TCP mode

**Check:**
1. Client is properly authenticated
2. Encryption is set up (CryptSetup message received)
3. Client is not muted/deafened
4. Edge server is properly routing UDPTunnel messages

**Debug:**
```typescript
// Enable debug logging
const client = new MumbleClient();
client.on('udpTunnel', (data) => {
  console.log('Received TCP voice packet:', data.length, 'bytes');
});
```

### Issue: Automatic fallback not working

**Check:**
1. Client has `forceTcpVoice` set to `false` or `undefined`
2. UDP errors are properly detected
3. Connection manager state updates correctly

**Debug:**
```typescript
const connMgr = client.getConnectionManager();
console.log('TCP mode:', connMgr.isUsingTcpVoice());
```

## Future Enhancements

Possible improvements for future versions:

1. **Dynamic mode switching**: Switch between TCP/UDP based on network quality
2. **Bandwidth optimization**: Compress TCP voice packets
3. **Statistics**: Track TCP vs UDP usage and performance metrics
4. **Hybrid mode**: Use both TCP and UDP simultaneously for redundancy
5. **Quality monitoring**: Adjust codec based on TCP latency

## Security

TCP voice packets maintain the same security as UDP voice:

- Encrypted using OCB2-AES128
- TLS encryption for TCP connection (additional layer)
- Same key exchange mechanism via CryptSetup message
- No additional security risks compared to UDP voice

## Conclusion

The TCP voice transport feature provides a reliable fallback mechanism for environments where UDP is not available or unreliable. The automatic fallback ensures seamless user experience while maintaining compatibility with existing Mumble protocol specifications.
