#!/usr/bin/env node
/**
 * 手动集成测试入口文件（展示模式）
 *
 * 启动完整测试环境（Hub + 3 个 Edge + 认证服务器），展示连接信息
 * 和可用用户，保持运行直到按下 Ctrl+C。
 *
 * Rust 模式下 Hub/Edge 进程的 stdout/stderr 会直接转发到本终端。
 *
 * 运行方式:
 *   npx tsx tests/integration/test-integration.ts
 *   MUNODE_USE_RUST=1 npx tsx tests/integration/test-integration.ts
 *
 * Rust 模式需要先编译：
 *   cd rust && cargo build --release
 */

// ① 在 setup.ts 加载前设置 TEST_DEBUG=1。
//   RustServerProcess.start() 内部根据 TEST_DEBUG 决定 stdio 模式：
//     TEST_DEBUG=1  →  stdio: 'inherit'  →  Rust stdout/stderr 转发到本终端
//     TEST_DEBUG=0  →  stdio: 'ignore'   →  Rust 输出静默丢弃
process.env.TEST_DEBUG = '1';

// 声明此文件为 ES 模块（顶层 await 需要）
export {};

// ② 动态导入——保证 ① 的 env 赋值在 setup.ts 模块求值前已生效。
//   若改为 static import，ESM 会先执行所有 import 语句再运行模块体，
//   导致 TEST_DEBUG 在 setup.ts 加载时仍为未设置状态。
const { setupTestEnvironment, USE_RUST } = await import('./setup.js');
const { testUserPasswords } = await import('./test-users.js');

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

const SEP  = '═'.repeat(64);
const SEP2 = '─'.repeat(64);

function banner(title: string): void {
  console.log(`\n${SEP}\n  ${title}\n${SEP}`);
}

function section(title: string): void {
  console.log(`\n  ▶ ${title}`);
  console.log(`  ${SEP2}`);
}

// ──────────────────────────────────────────────────────────────────
// 启动环境
// ──────────────────────────────────────────────────────────────────

banner(`MuNode 手动测试环境  [${USE_RUST ? 'Rust 模式' : 'TypeScript 模式'}]`);
console.log('  正在启动服务器，请稍候...\n');

let testEnv: Awaited<ReturnType<typeof setupTestEnvironment>>;

try {
  testEnv = await setupTestEnvironment(8080, {
    startHub:   true,
    startEdge:  true,
    startEdge2: true,
    startEdge3: true,
    startEdge4: false,
    startAuth:  true,
    silent:     false,  // 输出详细日志（TS 模式），Rust 模式同时启用 'inherit' stdio
    reuse:      false,  // 每次都创建全新环境，避免残留状态
    hubConfig: {
      bandwidth: 40000,
    }
  });
} catch (err) {
  console.error('\n✗ 测试环境启动失败:', err);
  process.exit(1);
}

console.log('\n  ✓ 所有服务器已就绪');

// ──────────────────────────────────────────────────────────────────
// 连接信息
// ──────────────────────────────────────────────────────────────────

banner('连接信息');

section('认证服务器');
console.log(`    HTTP  →  http://127.0.0.1:${testEnv.authPort}/auth`);

section('Hub 服务器');
console.log(`    控制端口  →  ${testEnv.controlPort}`);
console.log(`    Web API   →  http://127.0.0.1:${testEnv.webApiPort}`);

section('Edge 服务器（Mumble 客户端连接地址）');
const edges = [
  { label: 'Edge 1', port: testEnv.edgePort,  edgePort: testEnv.edgeEdgePort  },
  { label: 'Edge 2', port: testEnv.edgePort2, edgePort: testEnv.edgeEdgePort2 },
  { label: 'Edge 3', port: testEnv.edgePort3, edgePort: testEnv.edgeEdgePort3 },
  { label: 'Edge 4', port: testEnv.edgePort4, edgePort: testEnv.edgeEdgePort4 },
];

for (const e of edges) {
  if (e.port > 0) {
    console.log(`    ${e.label}  →  mumble://127.0.0.1:${e.port}  (Edge 间通信端口: ${e.edgePort})`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 可用用户列表
// ──────────────────────────────────────────────────────────────────

banner('可用测试用户（按 user_id 排序）');

const COL_USER = 28;
const COL_PASS = 26;
const COL_ID   = 10;

console.log(
  '  ' +
  '用户名'.padEnd(COL_USER) +
  '密码'.padEnd(COL_PASS) +
  'user_id'.padEnd(COL_ID) +
  '组'
);
console.log('  ' + SEP2);

const sortedUsers = Object.entries(testUserPasswords)
  .sort(([, a], [, b]) => a.user_id - b.user_id);

const MAX_DISPLAY = 40;
for (const [username, info] of sortedUsers.slice(0, MAX_DISPLAY)) {
  const groups = info.groups?.join(', ') ?? '—';
  console.log(
    '  ' +
    username.padEnd(COL_USER) +
    info.password.padEnd(COL_PASS) +
    String(info.user_id).padEnd(COL_ID) +
    groups
  );
}

if (sortedUsers.length > MAX_DISPLAY) {
  console.log(
    `\n  … 另有 ${sortedUsers.length - MAX_DISPLAY} 个用户` +
    '，详见 tests/integration/test-users.ts'
  );
}

// ──────────────────────────────────────────────────────────────────
// 运行提示
// ──────────────────────────────────────────────────────────────────

if (USE_RUST) {
  console.log(
    '\n  ℹ  Rust 模式：Hub/Edge 进程的 stdout/stderr 已通过 stdio:inherit 转发到本终端'
  );
}

banner('环境就绪  —  按 Ctrl+C 关闭所有服务');

// SIGINT / SIGTERM 由 setup.ts 在模块级注册的处理器负责清理并退出进程，
// 此处只需保持进程运行即可。
await new Promise<never>(() => {});
