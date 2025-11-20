import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// 自定义日志格式
const logFormat = printf(({ level, message, timestamp: ts, ...metadata }) => {
  let msg = `${ts} [${level}] ${message}`;

  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  return msg;
});

/**
 * 获取全局日志级别
 * 动态读取环境变量，支持运行时修改
 */
function getGlobalLogLevel(): string {
  return process.env.LOG_LEVEL || 'info';
}

/**
 * 全局logger注册表，用于动态更新日志级别
 */
const loggerRegistry: winston.Logger[] = [];

/**
 * 创建 logger 实例
 */
export function createLogger(options: {
  level?: string;
  service?: string;
  filename?: string;
}): winston.Logger {
  const { level = getGlobalLogLevel(), service = 'munode', filename } = options;
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
    }),
  ];

  if (filename) {
    transports.push(
      new winston.transports.File({
        filename,
        format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
      })
    );
  }

  const loggerInstance = winston.createLogger({
    level,
    format: combine(errors({ stack: true }), timestamp(), logFormat),
    defaultMeta: { service },
    transports,
  });

  // 将logger注册到全局注册表
  loggerRegistry.push(loggerInstance);

  return loggerInstance;
}

// 默认 logger，使用全局日志级别
export const logger = createLogger({ level: getGlobalLogLevel() });

/**
 * 设置全局日志级别
 * 会更新所有已创建的logger实例
 */
export function setGlobalLogLevel(level: string): void {
  process.env.LOG_LEVEL = level;

  // 更新所有注册的logger实例
  loggerRegistry.forEach((loggerInstance) => {
    loggerInstance.level = level;
    loggerInstance.transports.forEach((transport) => {
      transport.level = level;
    });
  });

  console.log(
    `[Logger] Global log level set to: ${level}, updated ${loggerRegistry.length} logger instances`
  );
}

export { getGlobalLogLevel };
