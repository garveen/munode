import { readFile } from 'fs/promises';
import { resolve } from 'path';

/**
 * 加载 JSON 配置文件
 */
export async function loadConfig<T>(configPath: string): Promise<T> {
  const absolutePath = resolve(configPath);
  const content = await readFile(absolutePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * 验证必需的配置字段
 */
export function validateConfig<T extends Record<string, unknown>>(
  config: T,
  requiredFields: (keyof T)[]
): void {
  const missing = requiredFields.filter((field) => !(field in config));

  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(', ')}`);
  }
}
