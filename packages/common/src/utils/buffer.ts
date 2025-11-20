/**
 * 读取大端序 uint16
 */
export function readUInt16BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16BE(offset);
}

/**
 * 读取大端序 uint32
 */
export function readUInt32BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

/**
 * 写入大端序 uint16
 */
export function writeUInt16BE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt16BE(value, offset);
}

/**
 * 写入大端序 uint32
 */
export function writeUInt32BE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32BE(value, offset);
}

/**
 * 连接多个 Buffer
 */
export function concatBuffers(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}
