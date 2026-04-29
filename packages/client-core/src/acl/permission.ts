/**
 * Permission constants used in `PermissionDenied`/`PermissionQuery` messages.
 * See `c-implement/src/ACL.h` for the upstream definitions.
 */

export const Permission = {
  None: 0x0,
  Write: 0x1,
  Traverse: 0x2,
  Enter: 0x4,
  Speak: 0x8,
  MuteDeafen: 0x10,
  Move: 0x20,
  MakeChannel: 0x40,
  LinkChannel: 0x80,
  Whisper: 0x100,
  TextMessage: 0x200,
  MakeTempChannel: 0x400,
  Listen: 0x800,
  // Server-wide
  Kick: 0x10000,
  Ban: 0x20000,
  Register: 0x40000,
  SelfRegister: 0x80000,
  ResetUserContent: 0x100000,
  // Aggregate
  Cached: 0x8000000,
  All: 0xf07ff,
} as const;

export type PermissionMask = number;
