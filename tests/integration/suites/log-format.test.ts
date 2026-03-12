/**
 * 结构化日志格式集成测试（仅 Rust 模式）
 *
 * 验证 Hub 和 Edge 在 `log_format = "json"` 时输出合法的 JSON 日志行，
 * 每行包含 `timestamp`、`level`、`fields.message`、`target` 字段。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { USE_RUST, findAvailablePort, sleep } from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const TMP_DIR = path.join(PROJECT_ROOT, 'tmp', 'log-format-test');
const CERTS_DIR = path.join(PROJECT_ROOT, 'tests', 'integration', 'certs');

/** 查找已编译的 Rust 二进制文件路径 */
function findRustBinary(name: string): string {
  const debugPath = path.join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const releasePath = path.join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debugPath)) return debugPath;
  if (fs.existsSync(releasePath)) return releasePath;
  throw new Error(
    `Rust binary '${name}' not found. Run 'cargo build' in the rust/ directory first.`,
  );
}

/**
 * 启动进程并捕获 stdout + stderr 输出行，返回捕获的行列表。
 * 自动在 `durationMs` 毫秒后终止进程。
 */
async function captureProcessOutput(
  bin: string,
  args: string[],
  durationMs: number,
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const capturedLines: string[] = [];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const collect = (chunk: Buffer) => {
      chunk
        .toString()
        .split('\n')
        .forEach((line) => {
          const trimmed = line.trim();
          if (trimmed) capturedLines.push(trimmed);
        });
    };

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => resolve(capturedLines), 300);
    }, durationMs);
  });
}

/** 解析 JSON 日志行并验证必需字段 */
interface JsonLogLine {
  timestamp: string;
  level: string;
  target: string;
  fields: Record<string, unknown>;
}

function parseAndValidateLine(raw: string): JsonLogLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Log line is not valid JSON: ${raw}`);
  }

  // Use any for intermediate validation since JSON structure is unknown at parse time
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = parsed as any;

  // tracing-subscriber JSON 格式要求的字段
  expect(typeof obj.timestamp, `timestamp field (line: ${raw})`).toBe('string');
  expect(typeof obj.level, `level field (line: ${raw})`).toBe('string');
  expect(
    ['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE'],
    `level value (line: ${raw})`,
  ).toContain(obj.level);
  expect(typeof obj.target, `target field (line: ${raw})`).toBe('string');
  expect(typeof obj.fields, `fields field (line: ${raw})`).toBe('object');
  expect(
    typeof obj.fields.message,
    `fields.message (line: ${raw})`,
  ).toBe('string');

  return obj as JsonLogLine;
}

describe.skipIf(!USE_RUST)('Structured JSON Log Format Tests (Rust)', () => {
  afterEach(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  });

  // ---------------------------------------------------------------------------
  // Hub JSON log format
  // ---------------------------------------------------------------------------

  it('Hub outputs valid JSON log lines when log_format = "json"', async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const controlPort = await findAvailablePort(15900);
    const webApiPort = await findAvailablePort(controlPort + 1);

    const dbPath = path.join(TMP_DIR, 'hub-json.db');
    const blobPath = path.join(TMP_DIR, 'blobs');
    const configPath = path.join(TMP_DIR, 'hub-json.json');

    const hubConfig = {
      network: { host: '127.0.0.1', control_port: controlPort },
      database: { path: dbPath },
      blob_store: { path: blobPath },
      web_api: { enabled: true, host: '127.0.0.1', port: webApiPort },
      auth: { allow_guest: true, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      log_level: 'info',
      log_format: 'json',
    };

    fs.writeFileSync(configPath, JSON.stringify(hubConfig, null, 2));

    const bin = findRustBinary('munode-hub');
    const capturedLines = await captureProcessOutput(bin, [configPath], 2000);

    expect(capturedLines.length).toBeGreaterThan(0);

    // Every captured line must be valid JSON with required fields
    for (const line of capturedLines) {
      parseAndValidateLine(line);
    }
  }, 15000);

  it('Hub JSON logs contain the startup message with control_port field', async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const controlPort = await findAvailablePort(15910);
    const webApiPort = await findAvailablePort(controlPort + 1);

    const dbPath = path.join(TMP_DIR, 'hub-startup.db');
    const configPath = path.join(TMP_DIR, 'hub-startup.json');

    const hubConfig = {
      network: { host: '127.0.0.1', control_port: controlPort },
      database: { path: dbPath },
      blob_store: { path: path.join(TMP_DIR, 'blobs2') },
      web_api: { enabled: false },
      auth: { allow_guest: true, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      log_level: 'info',
      log_format: 'json',
    };

    fs.writeFileSync(configPath, JSON.stringify(hubConfig, null, 2));

    const bin = findRustBinary('munode-hub');
    const capturedLines = await captureProcessOutput(bin, [configPath], 2000);

    const parsedLines = capturedLines.map(parseAndValidateLine);

    // There must be at least one startup log referencing the Hub server
    const startupLine = parsedLines.find(
      (obj) =>
        obj.level === 'INFO' &&
        typeof obj.fields.message === 'string' &&
        (obj.fields.message as string).includes('MuNode Hub'),
    );

    expect(startupLine, 'expected a Hub startup INFO log line').toBeDefined();

    // The startup line should carry the control_port structured field
    expect(
      startupLine!.fields.control_port,
      'startup log should include control_port field',
    ).toBeDefined();
  }, 15000);

  it('Hub text format (default) does NOT produce JSON lines', async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const controlPort = await findAvailablePort(15920);

    const dbPath = path.join(TMP_DIR, 'hub-text.db');
    const configPath = path.join(TMP_DIR, 'hub-text.json');

    const hubConfig = {
      network: { host: '127.0.0.1', control_port: controlPort },
      database: { path: dbPath },
      blob_store: { path: path.join(TMP_DIR, 'blobs3') },
      web_api: { enabled: false },
      auth: { allow_guest: true, require_auth_service: false },
      registry: { hmac_secret: 'test-secret', heartbeat_timeout: 90000 },
      log_level: 'info',
      // No log_format → defaults to "text"
    };

    fs.writeFileSync(configPath, JSON.stringify(hubConfig, null, 2));

    const bin = findRustBinary('munode-hub');
    const capturedLines = await captureProcessOutput(bin, [configPath], 2000);

    expect(capturedLines.length).toBeGreaterThan(0);

    // In text format, at least one log line should NOT be parseable as JSON
    const hasNonJsonLine = capturedLines.some((line) => {
      try {
        JSON.parse(line);
        return false; // successfully parsed → it's JSON (bad for this test)
      } catch {
        return true; // parse error → it's text format ✓
      }
    });

    expect(hasNonJsonLine).toBe(true);
  }, 15000);

  // ---------------------------------------------------------------------------
  // Edge JSON log format (Edge emits startup logs before Hub connection attempt)
  // ---------------------------------------------------------------------------

  it('Edge outputs valid JSON log lines when log_format = "json"', async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const edgePort = await findAvailablePort(15930);
    const edgeEdgePort = await findAvailablePort(edgePort + 1);

    const configPath = path.join(TMP_DIR, 'edge-json.json');

    const edgeConfig = {
      server_id: 1,
      name: 'Edge-LogTest',
      network: {
        host: '0.0.0.0',
        port: edgePort,
        edge_port: edgeEdgePort,
        external_host: '127.0.0.1',
      },
      tls: {
        cert: path.join(CERTS_DIR, 'server.pem'),
        key: path.join(CERTS_DIR, 'server.key'),
        ca: path.join(CERTS_DIR, 'ca.pem'),
      },
      // Point to a port that doesn't exist — Edge will log startup then fail to connect
      hub_server: {
        host: '127.0.0.1',
        control_port: 1, // Reserved port that will refuse connection
        hmac_secret: 'test-secret',
        reconnect_interval: 500,
        heartbeat_interval: 30000,
      },
      server: { capacity: 100, max_bandwidth: 558000 },
      log_level: 'info',
      log_format: 'json',
    };

    fs.writeFileSync(configPath, JSON.stringify(edgeConfig, null, 2));

    const bin = findRustBinary('munode-edge');
    const capturedLines = await captureProcessOutput(bin, [configPath], 2000);

    // Edge should emit at least the startup log before failing to connect to Hub
    expect(capturedLines.length).toBeGreaterThan(0);

    // Every captured line must be valid JSON with required fields
    for (const line of capturedLines) {
      parseAndValidateLine(line);
    }
  }, 15000);

  it('Edge JSON logs contain the startup message with server_id field', async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const edgePort = await findAvailablePort(15940);
    const edgeEdgePort = await findAvailablePort(edgePort + 1);

    const configPath = path.join(TMP_DIR, 'edge-startup.json');

    const edgeConfig = {
      server_id: 42,
      name: 'Edge-LogStartup',
      network: {
        host: '0.0.0.0',
        port: edgePort,
        edge_port: edgeEdgePort,
        external_host: '127.0.0.1',
      },
      tls: {
        cert: path.join(CERTS_DIR, 'server.pem'),
        key: path.join(CERTS_DIR, 'server.key'),
        ca: path.join(CERTS_DIR, 'ca.pem'),
      },
      hub_server: {
        host: '127.0.0.1',
        control_port: 1,
        hmac_secret: 'test-secret',
        reconnect_interval: 500,
        heartbeat_interval: 30000,
      },
      server: { capacity: 100, max_bandwidth: 558000 },
      log_level: 'info',
      log_format: 'json',
    };

    fs.writeFileSync(configPath, JSON.stringify(edgeConfig, null, 2));

    const bin = findRustBinary('munode-edge');
    const capturedLines = await captureProcessOutput(bin, [configPath], 2000);

    const parsedLines = capturedLines.map(parseAndValidateLine);

    // There must be an Edge startup INFO log
    const startupLine = parsedLines.find(
      (obj) =>
        obj.level === 'INFO' &&
        typeof obj.fields.message === 'string' &&
        (obj.fields.message as string).includes('MuNode Edge'),
    );

    expect(startupLine, 'expected an Edge startup INFO log line').toBeDefined();

    // Startup line should contain server_id
    expect(
      startupLine!.fields.server_id,
      'startup log should include server_id field',
    ).toBeDefined();
  }, 15000);
});
