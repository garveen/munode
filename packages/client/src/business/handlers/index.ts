/**
 * Business Handlers Index
 * 
 * 导出所有业务处理器
 */

export { ConnectHandler } from './connect-handler.js';
export { DisconnectHandler } from './disconnect-handler.js';
export { JoinChannelHandler } from './join-channel-handler.js';
export { SendMessageHandler } from './send-message-handler.js';
export {
  AddListeningChannelHandler,
  RemoveListeningChannelHandler,
  ClearListeningChannelsHandler,
  GetListeningChannelsHandler
} from './listen-channel-handler.js';
export { SetVoiceTargetHandler, RemoveVoiceTargetHandler } from './voice-target-handler.js';
export { SendPluginDataHandler } from './plugin-data-handler.js';
export { RegisterContextActionHandler, ExecuteContextActionHandler } from './context-action-handler.js';
export { AddWebhookHandler, RemoveWebhookHandler, GetWebhooksHandler } from './webhook-handler.js';
export {
  QueryACLHandler,
  SaveACLHandler,
  CheckPermissionHandler,
  GetUserPermissionsHandler,
  AddACLEntryHandler,
  RemoveACLEntryHandler,
  UpdateACLEntryHandler,
  CreateChannelGroupHandler,
  DeleteChannelGroupHandler,
  AddUserToGroupHandler,
  RemoveUserFromGroupHandler
} from './acl-handler.js';

// Additional handlers can be added here as needed:
// - CreateChannelHandler
// - DeleteChannelHandler
// - UpdateChannelHandler
// - KickUserHandler
// - BanUserHandler
// - UpdateUserStateHandler
// - SendAudioHandler (audio streaming not implemented)
// - StartAudioStreamHandler (audio streaming not implemented)
// - StopAudioStreamHandler (audio streaming not implemented)
// - SetSelfMuteHandler
// - SetSelfDeafHandler
// - SetRecordingHandler

