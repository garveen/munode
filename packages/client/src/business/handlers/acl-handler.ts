/**
 * ACL Handlers - ACL 相关业务处理器
 */

import type { BusinessHandler } from '../../types/api-types.js';
import type { ApiContext } from '../../types/api-types.js';
import type { MumbleClient } from '../../core/mumble-client.js';

/**
 * 查询 ACL 处理器
 */
export class QueryACLHandler implements BusinessHandler {
  async execute(params: { channelId: number }, context: ApiContext): Promise<any> {
    const { channelId } = params;
    const client = context.client as MumbleClient;

    const result = await client.queryACL(channelId);
    return {
      success: true,
      data: result
    };
  }
}

/**
 * 保存 ACL 处理器
 */
export class SaveACLHandler implements BusinessHandler {
  async execute(params: { channelId: number; acls: any[]; groups?: any }, context: ApiContext): Promise<any> {
    const { channelId, acls, groups } = params;
    const client = context.client as MumbleClient;

    const aclIds = await client.saveACL(channelId, acls, groups);
    return {
      success: true,
      data: { aclIds }
    };
  }
}

/**
 * 检查权限处理器
 */
export class CheckPermissionHandler implements BusinessHandler {
  async execute(params: { channelId: number; permission: number; userSession?: number }, context: ApiContext): Promise<any> {
    const { channelId, permission, userSession } = params;
    const client = context.client as MumbleClient;

    const hasPermission = await client.checkPermission(channelId, permission, userSession);
    return {
      success: true,
      data: { hasPermission }
    };
  }
}

/**
 * 获取用户权限处理器
 */
export class GetUserPermissionsHandler implements BusinessHandler {
  async execute(params: { channelId: number; userSession?: number }, context: ApiContext): Promise<any> {
    const { channelId, userSession } = params;
    const client = context.client as MumbleClient;

    const permissions = await client.getUserPermissions(channelId, userSession);
    return {
      success: true,
      data: { permissions }
    };
  }
}

/**
 * 添加 ACL 条目处理器
 */
export class AddACLEntryHandler implements BusinessHandler {
  async execute(params: { channelId: number; entry: any }, context: ApiContext): Promise<any> {
    const { channelId, entry } = params;
    const client = context.client as MumbleClient;

    const aclId = await client.addACLEntry(channelId, entry);
    return {
      success: true,
      data: { aclId }
    };
  }
}

/**
 * 移除 ACL 条目处理器
 */
export class RemoveACLEntryHandler implements BusinessHandler {
  async execute(params: { channelId: number; entryIndex: number }, context: ApiContext): Promise<any> {
    const { channelId, entryIndex } = params;
    const client = context.client as MumbleClient;

    await client.removeACLEntry(channelId, entryIndex);
    return {
      success: true,
      data: {}
    };
  }
}

/**
 * 更新 ACL 条目处理器
 */
export class UpdateACLEntryHandler implements BusinessHandler {
  async execute(params: { channelId: number; entryIndex: number; updates: any }, context: ApiContext): Promise<any> {
    const { channelId, entryIndex, updates } = params;
    const client = context.client as MumbleClient;

    await client.updateACLEntry(channelId, entryIndex, updates);
    return {
      success: true,
      data: {}
    };
  }
}

/**
 * 创建频道组处理器
 */
export class CreateChannelGroupHandler implements BusinessHandler {
  async execute(params: { channelId: number; groupName: string; inherited?: boolean; inheritable?: boolean }, context: ApiContext): Promise<any> {
    const { channelId, groupName, inherited, inheritable } = params;
    const client = context.client as MumbleClient;

    await client.createChannelGroup(channelId, groupName, inherited, inheritable);
    return {
      success: true,
      data: {}
    };
  }
}

/**
 * 删除频道组处理器
 */
export class DeleteChannelGroupHandler implements BusinessHandler {
  async execute(params: { channelId: number; groupName: string }, context: ApiContext): Promise<any> {
    const { channelId, groupName } = params;
    const client = context.client as MumbleClient;

    await client.deleteChannelGroup(channelId, groupName);
    return {
      success: true,
      data: {}
    };
  }
}

/**
 * 添加用户到组处理器
 */
export class AddUserToGroupHandler implements BusinessHandler {
  async execute(params: { channelId: number; groupName: string; userId: number }, context: ApiContext): Promise<any> {
    const { channelId, groupName, userId } = params;
    const client = context.client as MumbleClient;

    await client.addUserToGroup(channelId, groupName, userId);
    return {
      success: true,
      data: {}
    };
  }
}

/**
 * 从组移除用户处理器
 */
export class RemoveUserFromGroupHandler implements BusinessHandler {
  async execute(params: { channelId: number; groupName: string; userId: number }, context: ApiContext): Promise<any> {
    const { channelId, groupName, userId } = params;
    const client = context.client as MumbleClient;

    await client.removeUserFromGroup(channelId, groupName, userId);
    return {
      success: true,
      data: {}
    };
  }
}