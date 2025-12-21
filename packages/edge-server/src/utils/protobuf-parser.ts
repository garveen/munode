/**
 * Protobuf wire format parser utilities
 * 
 * These utilities allow parsing the raw protobuf wire format to determine
 * which fields are actually present in an encoded message, before decoding.
 * This is necessary because ts-proto's decoder fills in default values for
 * all optional fields, making it impossible to distinguish between "field not set"
 * and "field explicitly set to default value" after decoding.
 */

/**
 * Parse protobuf wire format to extract field numbers that are present in the message
 * 
 * @param data The raw protobuf encoded data
 * @returns A Set of field numbers that are present in the message
 */
export function getProtobufFieldNumbers(data: Buffer): Set<number> {
  const fieldNumbers = new Set<number>();
  let offset = 0;
  
  while (offset < data.length) {
    // Read varint tag
    let tag = 0;
    let shift = 0;
    let byte = 0;
    
    do {
      if (offset >= data.length) break;
      byte = data[offset++];
      tag |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    
    if (fieldNumber > 0) {
      fieldNumbers.add(fieldNumber);
    }
    
    // Skip field value based on wire type
    try {
      switch (wireType) {
        case 0: // Varint
          do {
            if (offset >= data.length) break;
            byte = data[offset++];
          } while (byte & 0x80);
          break;
          
        case 1: // 64-bit
          offset += 8;
          break;
          
        case 2: // Length-delimited
          let length = 0;
          shift = 0;
          do {
            if (offset >= data.length) break;
            byte = data[offset++];
            length |= (byte & 0x7f) << shift;
            shift += 7;
          } while (byte & 0x80);
          offset += length;
          break;
          
        case 5: // 32-bit
          offset += 4;
          break;
          
        default:
          // Unknown wire type, stop parsing
          return fieldNumbers;
      }
    } catch (e) {
      // If parsing fails, return what we have so far
      break;
    }
  }
  
  return fieldNumbers;
}

/**
 * UserState protobuf field number constants
 * From Mumble.proto message UserState
 */
export const UserStateFields = {
  SESSION: 1,
  ACTOR: 2,
  NAME: 3,
  USER_ID: 4,
  CHANNEL_ID: 5,
  MUTE: 6,
  DEAF: 7,
  SUPPRESS: 8,
  SELF_MUTE: 9,
  SELF_DEAF: 10,
  TEXTURE: 11,
  PLUGIN_CONTEXT: 12,
  PLUGIN_IDENTITY: 13,
  COMMENT: 14,
  HASH: 15,
  COMMENT_HASH: 16,
  TEXTURE_HASH: 17,
  PRIORITY_SPEAKER: 18,
  RECORDING: 19,
  TEMPORARY_ACCESS_TOKENS: 20,
  LISTENING_CHANNEL_ADD: 21,
  LISTENING_CHANNEL_REMOVE: 22,
} as const;
