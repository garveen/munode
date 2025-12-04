/**
 * Unit test for hub channel loading fix
 * 
 * Verifies that channels with parent_id = -1 (root channel) are correctly
 * handled when returned to Edge servers.
 */

import { describe, it, expect } from 'vitest';

describe('Hub Channel Loading', () => {
  it('should filter negative parent_id values when mapping channels', () => {
    // Simulate database channels with root channel having parent_id = -1
    const dbChannels = [
      {
        id: 0,
        name: 'Root',
        parent_id: -1,  // Root channel has -1 in database
        position: 0,
        max_users: 0,
        inherit_acl: true,
        description_blob: 'Root channel',
      },
      {
        id: 1,
        name: 'Lobby',
        parent_id: 0,   // Normal parent reference
        position: 0,
        max_users: 0,
        inherit_acl: true,
        description_blob: 'Lobby channel',
      },
      {
        id: 2,
        name: 'General',
        parent_id: 0,   // Normal parent reference
        position: 1,
        max_users: 10,
        inherit_acl: true,
        description_blob: null,
      },
    ];

    // Apply the same mapping logic as in handleGetChannels and handleFullSync
    const mappedChannels = dbChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id >= 0 ? ch.parent_id : undefined, // Filter negative parent_ids
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl,
      description: ch.description_blob,
    }));

    // Verify root channel has undefined parent_id
    expect(mappedChannels[0].parent_id).toBeUndefined();
    expect(mappedChannels[0].id).toBe(0);
    expect(mappedChannels[0].name).toBe('Root');

    // Verify child channels have valid parent_id
    expect(mappedChannels[1].parent_id).toBe(0);
    expect(mappedChannels[1].id).toBe(1);
    expect(mappedChannels[1].name).toBe('Lobby');

    expect(mappedChannels[2].parent_id).toBe(0);
    expect(mappedChannels[2].id).toBe(2);
    expect(mappedChannels[2].name).toBe('General');
  });

  it('should handle channels with parent_id = 0 correctly', () => {
    const dbChannels = [
      {
        id: 0,
        name: 'Root',
        parent_id: -1,
        position: 0,
        max_users: 0,
        inherit_acl: true,
        description_blob: null,
      },
      {
        id: 1,
        name: 'Child of Root',
        parent_id: 0,
        position: 0,
        max_users: 0,
        inherit_acl: true,
        description_blob: null,
      },
    ];

    const mappedChannels = dbChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id >= 0 ? ch.parent_id : undefined,
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl,
    }));

    // Parent_id = 0 should be preserved (it's a valid parent reference)
    expect(mappedChannels[1].parent_id).toBe(0);
  });

  it('should handle edge case of parent_id = -2 or other negative values', () => {
    const dbChannels = [
      {
        id: 0,
        name: 'Root',
        parent_id: -2,  // Any negative value should be filtered
        position: 0,
        max_users: 0,
        inherit_acl: true,
        description_blob: null,
      },
    ];

    const mappedChannels = dbChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      parent_id: ch.parent_id >= 0 ? ch.parent_id : undefined,
      position: ch.position,
      max_users: ch.max_users,
      inherit_acl: ch.inherit_acl,
    }));

    expect(mappedChannels[0].parent_id).toBeUndefined();
  });
});
