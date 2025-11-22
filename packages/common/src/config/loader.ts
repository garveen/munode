import { readFile } from 'fs/promises';
import { resolve, extname } from 'path';
import { pathToFileURL } from 'url';

/**
 * 加载配置文件（支持 .js 和 .json 格式）
 */
export async function loadConfig<T>(configPath: string): Promise<T> {
  const absolutePath = resolve(configPath);
  const ext = extname(absolutePath).toLowerCase();
  
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    // 加载 JS 配置文件
    const fileUrl = pathToFileURL(absolutePath).href;
    const module = await import(fileUrl);
    // 支持 default export 和 module.exports
    return (module.default || module) as T;
  } else {
    // 加载 JSON 配置文件（向后兼容）
    const content = await readFile(absolutePath, 'utf-8');
    return JSON.parse(content) as T;
  }
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
