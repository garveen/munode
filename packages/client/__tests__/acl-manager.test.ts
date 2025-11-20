/**
 * ACL Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ACLManager } from '../src/core/acl-manager.js';
import { MumbleClient } from '../src/core/mumble-client.js';
import { Permission } from '@munode/protocol';

describe('ACLManager', () => {
  let client: MumbleClient;
  let aclManager: ACLManager;

  beforeEach(() => {
    client = new MumbleClient();
    aclManager = new ACLManager(client);
  });

  describe('Initialization', () => {
    it('should create ACL manager instance', () => {
      expect(aclManager).toBeInstanceOf(ACLManager);
    });

    it('should have permission manager', () => {
      expect(aclManager.getPermissionManager()).toBeDefined();
    });
  });

  describe('Cache Management', () => {
    it('should clear cache', () => {
      expect(typeof aclManager.clearCache).toBe('function');
      aclManager.clearCache();
    });

    it('should clear cache for specific channel', () => {
      expect(typeof aclManager.clearCacheForChannel).toBe('function');
      aclManager.clearCacheForChannel(1);
    });

    it('should clear cache for specific user', () => {
      expect(typeof aclManager.clearCacheForUser).toBe('function');
      aclManager.clearCacheForUser(1);
    });
  });

  describe('ACL Operations', () => {
    it('should provide ACL query method', () => {
      expect(typeof aclManager.queryACL).toBe('function');
    });

    it('should provide ACL save method', () => {
      expect(typeof aclManager.saveACL).toBe('function');
    });

    it('should provide permission check method', () => {
      expect(typeof aclManager.checkPermission).toBe('function');
    });

    it('should provide user permissions method', () => {
      expect(typeof aclManager.getUserPermissions).toBe('function');
    });
  });

  describe('ACL Entry Management', () => {
    it('should provide ACL entry addition method', () => {
      expect(typeof aclManager.addACLEntry).toBe('function');
    });

    it('should provide ACL entry removal method', () => {
      expect(typeof aclManager.removeACLEntry).toBe('function');
    });

    it('should provide ACL entry update method', () => {
      expect(typeof aclManager.updateACLEntry).toBe('function');
    });
  });

  describe('Channel Group Management', () => {
    it('should provide channel group creation method', () => {
      expect(typeof aclManager.createChannelGroup).toBe('function');
    });

    it('should provide channel group deletion method', () => {
      expect(typeof aclManager.deleteChannelGroup).toBe('function');
    });

    it('should provide user addition to group method', () => {
      expect(typeof aclManager.addUserToGroup).toBe('function');
    });

    it('should provide user removal from group method', () => {
      expect(typeof aclManager.removeUserFromGroup).toBe('function');
    });
  });

  describe('Permission Constants', () => {
    it('should have permission constants defined', () => {
      expect(Permission.None).toBeDefined();
      expect(Permission.Write).toBeDefined();
      expect(Permission.Traverse).toBeDefined();
      expect(Permission.Enter).toBeDefined();
      expect(Permission.Speak).toBeDefined();
      expect(Permission.MuteDeafen).toBeDefined();
      expect(Permission.Move).toBeDefined();
      expect(Permission.MakeChannel).toBeDefined();
      expect(Permission.LinkChannel).toBeDefined();
      expect(Permission.Whisper).toBeDefined();
      expect(Permission.TextMessage).toBeDefined();
      expect(Permission.TempChannel).toBeDefined();
      expect(Permission.Listen).toBeDefined();
      expect(Permission.Kick).toBeDefined();
      expect(Permission.Ban).toBeDefined();
      expect(Permission.Register).toBeDefined();
      expect(Permission.SelfRegister).toBeDefined();
    });

    it('should have permission masks defined', () => {
      expect(Permission.AllPermissions).toBeDefined();
      expect(Permission.AllSubPermissions).toBeDefined();
    });
  });
});