/**
 * 集成测试固定数据和配置
 */

export interface TestUser {
  username: string;
  password: string;
  session?: number;
}

export interface TestChannel {
  id: number;
  name: string;
  parentId?: number;
}

/**
 * 测试用户数据
 */
export const TEST_USERS: Record<string, TestUser> = {
  admin: {
    username: 'admin',
    password: 'admin123',
  },
  user1: {
    username: 'user1',
    password: 'password1',
  },
  user2: {
    username: 'user2',
    password: 'password2',
  },
  guest: {
    username: 'guest',
    password: 'guest123',
  },
};

/**
 * 测试频道结构
 */
export const TEST_CHANNELS: Record<string, TestChannel> = {
  root: {
    id: 0,
    name: 'Root',
  },
  lobby: {
    id: 1,
    name: 'Lobby',
    parentId: 0,
  },
  general: {
    id: 2,
    name: 'General',
    parentId: 0,
  },
  private: {
    id: 3,
    name: 'Private',
    parentId: 0,
  },
};

/**
 * 测试服务器配置
 */
export const TEST_CONFIG = {
  hub: {
    host: 'localhost',
    port: 6502,
    rpcPort: 50051,
  },
  edge: {
    host: 'localhost',
    port: 64738,
    hubHost: 'localhost',
    hubRpcPort: 50051,
  },
};

/**
 * Mumble 协议消息类型
 */
export enum MessageType {
  Version = 0,
  UDPTunnel = 1,
  Authenticate = 2,
  Ping = 3,
  Reject = 4,
  ServerSync = 5,
  ChannelRemove = 6,
  ChannelState = 7,
  UserRemove = 8,
  UserState = 9,
  BanList = 10,
  TextMessage = 11,
  PermissionDenied = 12,
  ACL = 13,
  QueryUsers = 14,
  CryptSetup = 15,
  ContextActionModify = 16,
  ContextAction = 17,
  UserList = 18,
  VoiceTarget = 19,
  PermissionQuery = 20,
  CodecVersion = 21,
  UserStats = 22,
  RequestBlob = 23,
  ServerConfig = 24,
  SuggestConfig = 25,
}

/**
 * 权限标志
 */
export enum PermissionFlag {
  None = 0,
  Write = 1 << 0,
  Traverse = 1 << 1,
  Enter = 1 << 2,
  Speak = 1 << 3,
  Whisper = 1 << 4,
  MuteDeafen = 1 << 5,
  Move = 1 << 6,
  MakeChannel = 1 << 7,
  MakeTempChannel = 1 << 8,
  LinkChannel = 1 << 9,
  TextMessage = 1 << 10,
  Kick = 1 << 11,
  Ban = 1 << 12,
  Register = 1 << 13,
  SelfRegister = 1 << 14,
}
