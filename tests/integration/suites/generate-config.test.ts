/**
 * generate-config 子命令集成测试（Rust 模式）
 *
 * 测试 `munode-hub generate-config` 和 `munode-edge generate-config` 子命令：
 * - 成功写出默认 TOML 配置文件，退出码 0
 * - 输出文件内容是有效的 TOML（可通过 validate-config 验证）
 * - 目标文件已存在时以非零退出码报错（拒绝覆盖）
 * - 自定义路径参数正常工作
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { USE_RUST } from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const TMP_DIR = path.join(PROJECT_ROOT, 'tmp', 'gen-config-tests');

/** Find the compiled Rust binary path. */
function findBinary(name: string): string {
  const debug = path.join(PROJECT_ROOT, `rust/target/debug/${name}`);
  const release = path.join(PROJECT_ROOT, `rust/target/release/${name}`);
  if (fs.existsSync(debug)) return debug;
  if (fs.existsSync(release)) return release;
  throw new Error(`Binary not found: ${name}`);
}

/** Run binary with arguments synchronously and return stdout+stderr combined. */
function run(bin: string, args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000, cwd });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

// Clean up tmp dir after each test to avoid state leakage
afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── Hub generate-config ──────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Hub generate-config subcommand', () => {
  const HUB_BIN = () => findBinary('munode-hub');

  it('generate-config exits 0 and creates the file', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'hub.toml');

    const { exitCode, stdout } = run(HUB_BIN(), ['generate-config', outputPath]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('hub.toml');
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('generated Hub config contains expected TOML sections', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'hub-sections.toml');

    run(HUB_BIN(), ['generate-config', outputPath]);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('[network]');
    expect(content).toContain('[database]');
    expect(content).toContain('[registry]');
    expect(content).toContain('[auth]');
    expect(content).toContain('[limits]');
    expect(content).toContain('[auto_ban]');
    expect(content).toContain('[web_api]');
    expect(content).toContain('[blob_store]');
    expect(content).toContain('[voice_routing]');
  });

  it('generated Hub config is parseable by validate-config', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'hub-valid.toml');

    run(HUB_BIN(), ['generate-config', outputPath]);

    // validate-config should succeed on a freshly generated config
    const { exitCode, stdout } = run(HUB_BIN(), ['validate-config', outputPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('is valid');
  });

  it('generate-config refuses to overwrite an existing file', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'hub-exists.toml');
    fs.writeFileSync(outputPath, '# existing file');

    const { exitCode, stderr } = run(HUB_BIN(), ['generate-config', outputPath]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('already exists');
  });

  it('generate-config with default path writes hub.toml in cwd', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const defaultPath = path.join(TMP_DIR, 'hub.toml');

    // Run with no path argument — should default to hub.toml in cwd
    const { exitCode, stdout } = run(HUB_BIN(), ['generate-config'], TMP_DIR);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('hub.toml');
    expect(fs.existsSync(defaultPath)).toBe(true);
  });
});

// ─── Edge generate-config ─────────────────────────────────────────────────────

describe.skipIf(!USE_RUST)('Edge generate-config subcommand', () => {
  const EDGE_BIN = () => findBinary('munode-edge');

  it('generate-config exits 0 and creates the file', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'edge.toml');

    const { exitCode, stdout } = run(EDGE_BIN(), ['generate-config', outputPath]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('edge.toml');
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('generated Edge config contains expected TOML sections', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'edge-sections.toml');

    run(EDGE_BIN(), ['generate-config', outputPath]);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('[network]');
    expect(content).toContain('[tls]');
    expect(content).toContain('[hub_server]');
    expect(content).toContain('[server]');
    expect(content).toContain('[voice_routing]');
  });

  it('generated Edge config is parseable by validate-config', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'edge-valid.toml');

    run(EDGE_BIN(), ['generate-config', outputPath]);

    // validate-config should succeed on a freshly generated config
    const { exitCode, stdout } = run(EDGE_BIN(), ['validate-config', outputPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('is valid');
  });

  it('generate-config refuses to overwrite an existing file', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outputPath = path.join(TMP_DIR, 'edge-exists.toml');
    fs.writeFileSync(outputPath, '# existing file');

    const { exitCode, stderr } = run(EDGE_BIN(), ['generate-config', outputPath]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('already exists');
  });

  it('generate-config with default path writes edge.toml in cwd', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const defaultPath = path.join(TMP_DIR, 'edge.toml');

    // Run with no path argument — should default to edge.toml in cwd
    const { exitCode, stdout } = run(EDGE_BIN(), ['generate-config'], TMP_DIR);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('edge.toml');
    expect(fs.existsSync(defaultPath)).toBe(true);
  });
});
