/**
 * 读取变长整数 (Varint)
 * 用于 Mumble UDP 包解析
 */
export function readVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  let shift = 0;

  while (bytesRead < 9) {
    if (offset + bytesRead >= buffer.length) {
      throw new Error('Buffer overflow while reading varint');
    }

    const byte = buffer[offset + bytesRead];
    bytesRead++;

    if (shift < 28) {
      value |= (byte & 0x7f) << shift;
    } else {
      value |= (byte & 0x0f) << shift;
    }

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7;
  }

  return { value, bytesRead };
}

/**
 * 写入变长整数 (Varint)
 */
export function writeVarint(value: number): Buffer {
  const bytes: number[] = [];

  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }

  bytes.push(value & 0x7f);

  return Buffer.from(bytes);
}

/**
 * 计算 varint 所需字节数
 */
export function varintLength(value: number): number {
  let length = 1;

  while (value > 0x7f) {
    length++;
    value >>>= 7;
  }

  return length;
}
