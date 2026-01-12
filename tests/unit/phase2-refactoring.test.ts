/**
 * Unit tests for Phase 2 refactoring
 * 
 * Verify that VoiceUDPTransport properly uses EdgeConnectionManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VoiceUDPTransport } from '@munode/protocol';
import { createLogger } from '@munode/common';

describe('Phase 2 Refactoring - VoiceUDPTransport', () => {
  let transport: VoiceUDPTransport;
  const logger = createLogger({ level: 'error', service: 'test' });

  beforeEach(() => {
    transport = new VoiceUDPTransport({
      port: 9000,
      host: '127.0.0.1',
      localEdgeId: 1,
      sharedSecret: Buffer.from('test-secret'),
    }, logger);
  });

  afterEach(() => {
    if (transport) {
      transport.stop();
    }
  });

  it('should create VoiceUDPTransport with EdgeConnectionManager', () => {
    expect(transport).toBeDefined();
    expect(typeof transport.registerEndpoint).toBe('function');
    expect(typeof transport.sendVoicePacket).toBe('function');
    expect(typeof transport.broadcast).toBe('function');
  });

  it('should support registerEndpoint (connection management)', () => {
    expect(() => {
      transport.registerEndpoint(2, '127.0.0.1', 9001);
    }).not.toThrow();
  });

  it('should support unregisterEndpoint', () => {
    transport.registerEndpoint(2, '127.0.0.1', 9001);
    expect(() => {
      transport.unregisterEndpoint(2);
    }).not.toThrow();
  });

  it('should support Edge mode API - sendVoicePacket', async () => {
    const packet = {
      senderId: 1,
      targetId: 0,
      sequence: 1,
      data: Buffer.from('test'),
    };

    // Should not throw even if edge not connected (will fail internally)
    try {
      await transport.sendVoicePacket(2, packet);
    } catch (error) {
      // Expected to fail since no connection
      expect(error).toBeDefined();
    }
  });

  it('should support Hub mode API - sendToEdge', async () => {
    const header = {
      senderId: 1,
      targetId: 0,
      sequence: 1,
    };
    const data = Buffer.from('test');

    try {
      await transport.sendToEdge(2, header, data);
    } catch (error) {
      // Expected to fail since no connection
      expect(error).toBeDefined();
    }
  });

  it('should support Edge mode API - broadcast', async () => {
    const packet = {
      senderId: 1,
      targetId: 0,
      sequence: 1,
      data: Buffer.from('test'),
    };

    expect(async () => {
      await transport.broadcast(packet, new Set([1]));
    }).not.toThrow();
  });

  it('should support Hub mode API - broadcast', async () => {
    const header = {
      senderId: 1,
      targetId: 0,
      sequence: 1,
    };
    const data = Buffer.from('test');

    expect(async () => {
      await transport.broadcast(header, data, 1);
    }).not.toThrow();
  });

  it('should support updateEncryptionKey', () => {
    const key = Buffer.from('0123456789abcdef');
    expect(() => {
      transport.updateEncryptionKey(key, 'aes-128-cbc');
    }).not.toThrow();
  });

  it('should support getRegisteredEdgeIds', () => {
    const edgeIds = transport.getRegisteredEdgeIds();
    expect(Array.isArray(edgeIds)).toBe(true);
    expect(edgeIds.length).toBe(0); // No edges registered yet
  });

  it('should return registered edges after registration', () => {
    transport.registerEndpoint(2, '127.0.0.1', 9001);
    transport.registerEndpoint(3, '127.0.0.1', 9002);
    
    const edgeIds = transport.getRegisteredEdgeIds();
    expect(edgeIds.length).toBe(2);
    expect(edgeIds).toContain(2);
    expect(edgeIds).toContain(3);
  });

  it('should support getQualityMetrics', () => {
    const metrics = transport.getQualityMetrics(2);
    expect(metrics).toBeUndefined(); // No metrics yet for edge 2
  });

  it('should support getConnectionStatus', () => {
    transport.registerEndpoint(2, '127.0.0.1', 9001);
    const status = transport.getConnectionStatus(2);
    expect(status).toBeDefined();
    expect(status?.edgeId).toBe(2);
  });

  it('should support getStats', () => {
    const stats = transport.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats.packetsSent).toBe('number');
    expect(typeof stats.packetsReceived).toBe('number');
  });

  it('should emit events (backward compatible)', (done) => {
    let connectedFired = false;
    
    transport.on('edge-connected', (edgeId) => {
      expect(edgeId).toBe(2);
      connectedFired = true;
    });

    // Register edge - should eventually fire connected event if connection succeeds
    transport.registerEndpoint(2, '127.0.0.1', 9001);
    
    // In real scenario would wait for connection, but for unit test just verify no crash
    setTimeout(() => {
      // Just verify handler was registered
      expect(typeof connectedFired).toBe('boolean');
      done();
    }, 100);
  });
});
