/**
 * 集成测试入口配置
 * 
 * 导出所有测试套件供测试运行器使用
 */

// 导出测试框架
export * from './setup';
export * from './helpers';
export * from './fixtures';

// 测试套件将由测试运行器自动发现
// 位于 suites/ 目录下的所有 *.test.ts 文件
