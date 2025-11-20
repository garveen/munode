import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { createLogger } from '@munode/common';
import type { DatabaseConfig, RegisteredEdge, VoiceTargetConfig } from './types.js';
import { GlobalSession } from '@munode/protocol';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ACLData } from './acl-manager.js';
import type { ChannelGroupData, ChannelGroupMemberData } from './channel-group-manager.js';

const logger = createLogger({ service: 'hub-database' });

/**
 * Hub Server 数据库管理器
 * 使用异步 SQLite 提供持久化存储
 */
export class HubDatabase {
  private db!: Database<sqlite3.Database, sqlite3.Statement>;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  /**
   * 初始化数据库连接
   */
  async init(): Promise<void> {
    // 初始化数据库
    this.db = await open({
      filename: this.config.path,
      driver: sqlite3.Database,
    });

    // 优化配置
    await this.db.run('PRAGMA journal_mode = WAL');
    await this.db.run('PRAGMA synchronous = NORMAL');
    await this.db.run('PRAGMA cache_size = -64000');
    await this.db.run('PRAGMA foreign_keys = ON');

    await this.initSchema();
    this.startBackupTask();
  }

  /**
   * 初始化数据库结构
   * 注意：以下表结构与Go版本保持一致，便于数据迁移
   */
  private async initSchema(): Promise<void> {
    const schema = `
      -- ====================
      -- Go代码兼容表结构
      -- ====================
      
      -- 封禁表 (与 Go ban.go 的 Ban struct 兼容)
      -- 对应 gorm.Model + Ban 字段
      CREATE TABLE IF NOT EXISTS bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME,
        updated_at DATETIME,
        deleted_at DATETIME,
        address BLOB NOT NULL,
        mask INTEGER NOT NULL,
        name TEXT,
        hash TEXT,
        reason TEXT,
        start INTEGER,
        duration INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_bans_deleted_at ON bans(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_bans_address ON bans(address);
      CREATE INDEX IF NOT EXISTS idx_bans_hash ON bans(hash);

      -- 频道表 (与 Go channel.go 的 Channel struct 兼容)
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        max_users INTEGER NOT NULL DEFAULT 0,
        parent_id INTEGER NOT NULL DEFAULT 0,
        inherit_acl INTEGER NOT NULL DEFAULT 1,
        description_blob TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_channel_parentid ON channels(parent_id);

      -- 频道链接表 (多对多关系)
      CREATE TABLE IF NOT EXISTS channel_links (
        channel_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        PRIMARY KEY (channel_id, target_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      -- ACL 表 (与 Go acl.go 的 ACL struct 兼容)
      CREATE TABLE IF NOT EXISTS acls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME,
        updated_at DATETIME,
        deleted_at DATETIME,
        channel_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL DEFAULT -1,
        "group" TEXT,
        apply_here INTEGER NOT NULL,
        apply_subs INTEGER NOT NULL,
        allow INTEGER,
        deny INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_acls_deleted_at ON acls(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_acl_channelid ON acls(channel_id);

      -- 频道组表 (Channel Groups)
      CREATE TABLE IF NOT EXISTS channel_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        inherit INTEGER NOT NULL DEFAULT 1,
        inheritable INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME,
        updated_at DATETIME,
        UNIQUE(channel_id, name),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_channel_groups_channel ON channel_groups(channel_id);
      CREATE INDEX IF NOT EXISTS idx_channel_groups_name ON channel_groups(name);

      -- 频道组成员表 (Channel Group Members)
      CREATE TABLE IF NOT EXISTS channel_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        is_add INTEGER NOT NULL,
        created_at DATETIME,
        FOREIGN KEY (channel_group_id) REFERENCES channel_groups(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_channel_group_members_group ON channel_group_members(channel_group_id);
      CREATE INDEX IF NOT EXISTS idx_channel_group_members_user ON channel_group_members(user_id);

      -- 用户最后频道表 (与 Go client.go 的 UserLastChannel struct 兼容)
      CREATE TABLE IF NOT EXISTS user_last_channels (
        id INTEGER PRIMARY KEY,
        last_channel INTEGER
      );

      -- 用户表 (存储注册用户信息和blob引用)
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT,
        texture_blob TEXT,
        comment_blob TEXT,
        last_seen INTEGER,
        last_channel INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);

      -- ====================
      -- Hub Server 专用表
      -- ====================

      -- 注意：Edge服务器信息不持久化，仅存储在内存中（ServiceRegistry）
      -- Edge是临时运行时节点，重启后需要重新注册

      -- Session 会话表（跨Edge的会话信息，仅存储活跃会话）
      -- 注意：这个表也应该考虑是否需要持久化，可能只需要内存存储

      -- 会话管理表
      CREATE TABLE IF NOT EXISTS sessions (
        session_id INTEGER PRIMARY KEY,
        edge_id INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT,
        ip_address TEXT,
        cert_hash TEXT,
        is_authenticated INTEGER DEFAULT 0,
        channel_id INTEGER,
        is_muted INTEGER DEFAULT 0,
        is_deafened INTEGER DEFAULT 0,
        connected_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        FOREIGN KEY (edge_id) REFERENCES edges(server_id) ON DELETE CASCADE
      );

      -- VoiceTarget 注册表
      CREATE TABLE IF NOT EXISTS voice_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        edge_id INTEGER NOT NULL,
        client_session INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(edge_id, client_session, target_id),
        FOREIGN KEY (edge_id) REFERENCES edges(server_id) ON DELETE CASCADE
      );

      -- 配置表
      CREATE TABLE IF NOT EXISTS configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at INTEGER NOT NULL
      );

      -- 审计日志表
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        edge_id INTEGER,
        session_id INTEGER,
        message TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      -- ====================
      -- 索引
      -- ====================
      CREATE INDEX IF NOT EXISTS idx_edges_status ON edges(status);
      CREATE INDEX IF NOT EXISTS idx_edges_region ON edges(region);
      CREATE INDEX IF NOT EXISTS idx_edges_last_heartbeat ON edges(last_heartbeat);
      CREATE INDEX IF NOT EXISTS idx_sessions_edge ON sessions(edge_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_cert ON sessions(cert_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_connected_at ON sessions(connected_at);
      CREATE INDEX IF NOT EXISTS idx_voice_targets_edge_session ON voice_targets(edge_id, client_session);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_type ON audit_logs(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_edge ON audit_logs(edge_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at);

      -- ====================
      -- 预设配置
      -- ====================
      INSERT OR IGNORE INTO configs (key, value, description, updated_at) VALUES
        ('server.name', '"Munode Hub Server"', 'Hub 服务器名称', strftime('%s', 'now')),
        ('server.max_bandwidth', '1000000000', '最大带宽 (bytes/s)', strftime('%s', 'now')),
        ('server.welcome_text', '"欢迎使用 Munode"', '欢迎消息', strftime('%s', 'now')),
        ('server.max_users', '5000', '全局最大用户数', strftime('%s', 'now'));
    `;

    await this.db.exec(schema);
    logger.info('Database schema initialized (Go-compatible)');

    // 迁移旧的列名
    await this.migrateSchema();

    // 初始化根频道
    await this.initRootChannel('Root');
  }

  /**
   * 迁移数据库结构
   */
  private async migrateSchema(): Promise<void> {
    try {
      // 检查 channels 表是否有旧的 description 列
      const pragma = await this.db.prepare('PRAGMA table_info(channels)');
      const columns = await pragma.all();
      
      const hasDescription = columns.some((col: any) => col.name === 'description');
      const hasDescriptionBlob = columns.some((col: any) => col.name === 'description_blob');

      if (hasDescription && !hasDescriptionBlob) {
        logger.info('Migrating channels table: renaming description to description_blob');
        await this.db.exec('ALTER TABLE channels RENAME COLUMN description TO description_blob');
      } else if (hasDescription && hasDescriptionBlob) {
        logger.warn(
          'Channels table has both description and description_blob columns, this should not happen'
        );
      }

      // 检查其他可能的迁移...

    } catch (error) {
      logger.error('Schema migration failed:', error);
      // 不抛出错误，继续启动
    }
  }

  /**
   * Edge服务器信息不持久化到数据库
   * Edge是临时运行时节点，信息仅存储在ServiceRegistry的内存中
   * 重启后Edge需要重新注册
   */

  /**
   * 获取活跃的 Edge 服务器（已废弃）
   * Edge信息不再持久化，此方法返回空数组
   * 使用 ServiceRegistry.getEdgeList() 获取当前活跃的Edge
   */
  async getActiveEdges(): Promise<RegisteredEdge[]> {
    // Edge不持久化，返回空数组
    return [];
  }

  /**
   * 保存会话信息
   * 注意：sessions表也应该考虑是否需要持久化，可能只需要内存存储
   */
  async saveSession(session: GlobalSession): Promise<void> {
    // Edge不再持久化到数据库，跳过Edge检查
    // Session信息仍然保存（但这个也应该考虑改为内存存储）

    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_id, edge_id, user_id, username, ip_address,
        cert_hash, is_authenticated, channel_id, connected_at, last_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    await stmt.run(
      session.session_id,
      session.edge_id,
      session.user_id,
      session.username,
      session.ip_address,
      session.cert_hash || '',
      session.is_authenticated ? 1 : 0,
      session.channel_id || null,
      session.connected_at,
      session.last_active,
    );
  }

  /**
   * 更新会话频道
   */
  async updateSessionChannel( session_id: number,  channel_id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      UPDATE sessions
      SET channel_id = ?, last_active = ?
      WHERE session_id = ?
    `);

    const now = Math.floor(Date.now() / 1000);
    await stmt.run(channel_id, now, session_id);
  }

  /**
   * 删除会话
   */
  async deleteSession( session_id: number): Promise<void> {
    const stmt = await this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    await stmt.run(session_id);
  }

  /**
   * 获取所有会话
   */
  async getAllSessions(): Promise<GlobalSession[]> {
    const stmt = await this.db.prepare('SELECT * FROM sessions');
    const rows = await stmt.all();

    return rows.map((row: any): GlobalSession => ({
      session_id: row.session_id as number,
      edge_id: row.edge_id as number,
      user_id: row.user_id as number,
      username: row.username as string,
      ip_address: row.ip_address as string,
      cert_hash: row.cert_hash as string,
      is_authenticated: (row.is_authenticated as number) === 1,
      channel_id: row.channel_id as number,
      connected_at: row.connected_at as number,
      last_active: row.last_active as number,
    }));
  }

  /**
   * 保存 VoiceTarget 配置
   */
  async saveVoiceTarget(config: VoiceTargetConfig): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO voice_targets (
        edge_id, client_session, target_id, target_type,
        target_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Math.floor(Date.now() / 1000);
    await stmt.run(
      config.edge_id,
      config.client_session,
      config.target_id,
      config.config ? 'channel' : 'delete',
      config.config ? JSON.stringify(config.config) : '',
      now,
      now
    );
  }

  /**
   * 获取所有 VoiceTarget 配置
   */
  async getAllVoiceTargets(): Promise<VoiceTargetConfig[]> {
    const stmt = await this.db.prepare('SELECT * FROM voice_targets');
    const rows = await stmt.all();

    return rows.map((row) => ({
       edge_id: row.edge_id,
       client_session: row.client_session,
       target_id: row.target_id,
      config: row.target_type === 'delete' ? null : JSON.parse(row.target_value),
      timestamp: row.updated_at * 1000,
    }));
  }

  /**
   * 获取配置值
   */
  async getConfig(key: string): Promise<string | null> {
    const stmt = await this.db.prepare('SELECT value FROM configs WHERE key = ?');
    const row = await stmt.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  /**
   * 设置配置值
   */
  async setConfig(key: string, value: any, description?: string): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO configs (key, value, description, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    const now = Math.floor(Date.now() / 1000);
    await stmt.run(key, JSON.stringify(value), description || null, now);
  }

  /**
   * 记录审计日志
   */
  async logAudit(event: {
    type: string;
    edge_id?: number;
    session_id?: number;
    message: string;
    metadata?: any;
  }): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT INTO audit_logs (event_type, edge_id, session_id, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = Math.floor(Date.now() / 1000);
    await stmt.run(
      event.type,
      event.edge_id || null,
      event.session_id || null,
      event.message,
      JSON.stringify(event.metadata || {}),
      now
    );
  }

  /**
   * 清理过期数据
   */
  async cleanup(): Promise<void> {
    const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;

    // 清理离线会话
    const sessionStmt = await this.db.prepare('DELETE FROM sessions WHERE last_active < ?');
    const sessionResult = await sessionStmt.run(oneDayAgo);
    const deletedSessions = sessionResult.changes || 0;

    // 清理旧日志 (保留7天)
    const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const logStmt = await this.db.prepare('DELETE FROM audit_logs WHERE created_at < ?');
    const logResult = await logStmt.run(oneWeekAgo);
    const deletedLogs = logResult.changes || 0;

    if (deletedSessions > 0 || deletedLogs > 0) {
      logger.info(`Database cleanup: ${deletedSessions} sessions, ${deletedLogs} logs`);
    }
  }

  /**
   * 启动定期备份任务
   */
  private startBackupTask(): void {
    setInterval(async () => {
      try {
        await this.createBackup();
      } catch (error) {
        logger.error('Database backup failed:', error);
      }
    }, this.config.backupInterval);
  }

  /**
   * 创建数据库备份
   */
  private async createBackup(): Promise<void> {
    try {
      // 确保备份目录存在
      await fs.mkdir(this.config.backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const backupPath = path.join(this.config.backupDir, `hub-${timestamp}.db`);

      // 使用 VACUUM INTO 创建备份
      await this.db.exec(`VACUUM INTO '${backupPath}'`);

      logger.info(`Database backup created: ${backupPath}`);

      // 清理旧备份 (保留30天)
      await this.cleanupOldBackups();
    } catch (error) {
      logger.error('Failed to create database backup:', error);
    }
  }

  /**
   * 清理旧备份
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.backupDir);
      const now = Date.now();
      const maxAge = 30 * 24 * 3600 * 1000; // 30天

      for (const file of files) {
        if (!file.endsWith('.db')) continue;

        const filePath = path.join(this.config.backupDir, file);
        const stat = await fs.stat(filePath);
        const age = now - stat.mtimeMs;

        if (age > maxAge) {
          await fs.unlink(filePath);
          logger.info(`Deleted old backup: ${file}`);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old backups:', error);
    }
  }

  /**
   * 获取证书指纹
   */
  /**
   * 获取证书指纹（保留以备未来使用）
   */
  // @ts-expect-error - 保留方法以备未来使用
  private getCertFingerprint(certPem: string): string {
    try {
      const forge = require('node-forge');
      const cert = forge.pki.certificateFromPem(certPem);
      const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
      const md = forge.md.sha256.create();
      md.update(der);
      return md.digest().toHex();
    } catch (error) {
      return '';
    }
  }

  // ====================
  // Go 兼容表操作方法
  // ====================

  /**
   * 获取所有未删除的封禁记录
   */
  async getAllBans(): Promise<
    Array<{
      id: number;
      address: Buffer;
      mask: number;
      name?: string;
      hash?: string;
      reason?: string;
      start?: number;
      duration?: number;
    }>
  > {
    const stmt = await this.db.prepare(`
      SELECT * FROM bans 
      WHERE deleted_at IS NULL
      ORDER BY id DESC
    `);
    return await stmt.all();
  }

  /**
   * 添加封禁记录
   */
  async addBan(ban: {
    address: Buffer;
    mask: number;
    name?: string;
    hash?: string;
    reason?: string;
    start?: number;
    duration?: number;
  }): Promise<number> {
    const stmt = await this.db.prepare(`
      INSERT INTO bans (created_at, updated_at, address, mask, name, hash, reason, start, duration)
      VALUES (datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      ban.address,
      ban.mask,
      ban.name || null,
      ban.hash || null,
      ban.reason || null,
      ban.start || null,
      ban.duration || null
    );

    return result.lastID || 0;
  }

  /**
   * 删除封禁记录 (软删除)
   */
  async deleteBan(id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      UPDATE bans SET deleted_at = datetime('now') WHERE id = ?
    `);
    await stmt.run(id);
  }

  /**
   * 清空所有封禁记录
   */
  async purgeBans(): Promise<void> {
    await this.db.run('DELETE FROM bans');
    await this.db.run("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'bans'");
    await this.db.run('VACUUM');
  }

  /**
   * 根据证书哈希检查是否被封禁
   */
  async isCertHashBanned(hash: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const stmt = await this.db.prepare(`
      SELECT COUNT(*) as count FROM bans 
      WHERE hash = ? 
        AND deleted_at IS NULL
        AND (start + duration > ? OR duration = 0)
    `);
    const result = await stmt.get(hash, now);
    return result.count > 0;
  }

  /**
   * 根据IP地址检查是否被封禁 (需要实现CIDR匹配)
   */
  async isIPBanned(ip: Buffer): Promise<boolean> {
    const stmt = await this.db.prepare(`
      SELECT address, mask FROM bans 
      WHERE deleted_at IS NULL
        AND address IS NOT NULL
    `);
    const bans = await stmt.all();

    // 简化版本：需要实现完整的CIDR匹配逻辑
    for (const ban of bans) {
      if (ban.address.equals(ip)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取所有频道
   */
  async getAllChannels(): Promise<
    Array<{
      id: number;
      name: string;
      position: number;
      max_users: number;
      parent_id: number;
      inherit_acl: boolean;
      description_blob?: string;
    }>
  > {
    const stmt = await this.db.prepare('SELECT * FROM channels ORDER BY id ASC');
    const rows = await stmt.all();
    return rows.map((row: any) => ({
      ...row,
      inherit_acl: row.inherit_acl === 1,
    }));
  }

  /**
   * 获取频道
   */
  async getChannel(id: number): Promise<any> {
    const stmt = await this.db.prepare('SELECT * FROM channels WHERE id = ?');
    return await stmt.get(id);
  }

  /**
   * 创建频道
   */
  async createChannel(channel: {
    name: string;
    position?: number;
    max_users?: number;
    parent_id?: number;
    inherit_acl?: boolean;
    description_blob?: string;
  }): Promise<number> {
    const stmt = await this.db.prepare(`
      INSERT INTO channels (name, position, max_users, parent_id, inherit_acl, description_blob)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      channel.name,
      channel.position || 0,
      channel.max_users || 0,
      channel.parent_id || 0,
      channel.inherit_acl !== undefined ? (channel.inherit_acl ? 1 : 0) : 1,
      channel.description_blob || null
    );

    return result.lastID || 0;
  }

  /**
   * 更新频道
   */
  async updateChannel(
    id: number,
    updates: Partial<{
      name: string;
      position: number;
      max_users: number;
      parent_id: number;
      inherit_acl: boolean;
      description_blob: string;
    }>
  ): Promise<void> {
    const fields = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const values = Object.values(updates).map((value) => 
      typeof value === 'boolean' ? (value ? 1 : 0) : value
    );

    const stmt = await this.db.prepare(`UPDATE channels SET ${fields} WHERE id = ?`);
    await stmt.run(...values, id);
  }

  /**
   * 删除频道
   */
  async deleteChannel(id: number): Promise<void> {
    if (id === 0) {
      throw new Error('Cannot delete root channel');
    }
    const stmt = await this.db.prepare('DELETE FROM channels WHERE id = ?');
    await stmt.run(id);
  }

  /**
   * 获取子频道
   */
  async getChildChannels( parent_id: number): Promise<Array<any>> {
    const stmt = await this.db.prepare(
      'SELECT * FROM channels WHERE parent_id = ? ORDER BY position ASC'
    );
    return await stmt.all(parent_id);
  }

  /**
   * 获取频道链接
   */
  async getChannelLinks( channel_id: number): Promise<number[]> {
    const stmt = await this.db.prepare(`
      SELECT target_id FROM channel_links WHERE channel_id = ?
    `);
    const rows = await stmt.all(channel_id);
    return rows.map((row) => row.target_id);
  }

  /**
   * 链接两个频道
   */
  async linkChannels( channel_id: number,  target_id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT OR IGNORE INTO channel_links (channel_id, target_id)
      VALUES (?, ?), (?, ?)
    `);
    await stmt.run(channel_id, target_id, target_id, channel_id);
  }

  /**
   * 取消链接两个频道
   */
  async unlinkChannels( channel_id: number,  target_id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      DELETE FROM channel_links 
      WHERE (channel_id = ? AND target_id = ?)
         OR (channel_id = ? AND target_id = ?)
    `);
    await stmt.run(channel_id, target_id, target_id, channel_id);
  }

  /**
   * 获取频道的所有 ACL
   * 如果 channel_id 为 0，则返回所有频道的 ACL
   */
  async getChannelACLs( channel_id: number): Promise<ACLData[]> {
    let query: string;
    let params: any[];

    if (channel_id === 0) {
      // 获取所有频道的ACL
      query = `
        SELECT * FROM acls
        WHERE deleted_at IS NULL
        ORDER BY channel_id ASC, id ASC
      `;
      params = [];
    } else {
      // 获取特定频道的ACL
      query = `
        SELECT * FROM acls
        WHERE channel_id = ? AND deleted_at IS NULL
        ORDER BY id ASC
      `;
      params = [channel_id];
    }

    const stmt = await this.db.prepare(query);
    const result = await stmt.all(...params);
    result.forEach((acl: ACLData) => {
      if (acl.user_id === 0) {
        delete acl.user_id;
      }
    });
    return result;
  }

  /**
   * 添加 ACL
   */
  async addACL(acl: {
    channel_id: number;
    user_id?: number;
    group?: string;
    apply_here: boolean;
    apply_subs: boolean;
    allow: number;
    deny: number;
  }): Promise<number> {
    const stmt = await this.db.prepare(`
      INSERT INTO acls (
        created_at, updated_at, channel_id, user_id, "group",
        apply_here, apply_subs, allow, deny
      ) VALUES (datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      acl.channel_id,
      acl.user_id !== undefined ? acl.user_id : 0,
      acl.group || null,
      acl.apply_here ? 1 : 0,
      acl.apply_subs ? 1 : 0,
      acl.allow,
      acl.deny
    );

    return result.lastID || 0;
  }

  /**
   * 更新 ACL
   */
  async updateACL(id: number, updates: Partial<ACLData>): Promise<void> {
    const fields = Object.keys(updates)
      .map((key) => (key === 'group' ? `"group" = ?` : `${key} = ?`))
      .join(', ');
    const values = Object.values(updates);

    const stmt = await this.db.prepare(`
      UPDATE acls SET ${fields}, updated_at = datetime('now') WHERE id = ?
    `);
    await stmt.run(...values, id);
  }

  /**
   * 删除 ACL (软删除)
   */
  async deleteACL(id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      UPDATE acls SET deleted_at = datetime('now') WHERE id = ?
    `);
    await stmt.run(id);
  }

  /**
   * 清空频道的所有 ACL
   */
  async clearChannelACLs( channel_id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      UPDATE acls SET deleted_at = datetime('now') WHERE channel_id = ?
    `);
    await stmt.run(channel_id);
  }

  /**
   * 获取用户最后所在频道
   */
  async getUserLastChannel( user_id: number): Promise<number> {
    const stmt = await this.db.prepare('SELECT last_channel FROM user_last_channels WHERE id = ?');
    const row = await stmt.get(user_id);
    return row ? row.last_channel : 0;
  }

  /**
   * 设置用户最后所在频道
   */
  async setUserLastChannel( user_id: number,  channel_id: number): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT OR REPLACE INTO user_last_channels (id, last_channel)
      VALUES (?, ?)
    `);
    await stmt.run(user_id, channel_id);
  }

  /**
   * 初始化根频道（如果不存在）
   */
  async initRootChannel(name: string = 'Root'): Promise<void> {
    const existingRoot = await this.getChannel(0);

    if (!existingRoot) {
      // 插入根频道，ID 固定为 0
      await this.db.run(
        `
        INSERT INTO channels (id, name, position, max_users, parent_id, inherit_acl, description_blob)
        VALUES (0, ?, 0, 0, -1, 1, NULL)
      `,
        name
      );

      logger.info(`Root channel created: ${name}`);
    } else if (existingRoot.name !== name) {
      // 更新根频道名称
      await this.db.run('UPDATE channels SET name = ? WHERE id = 0', name);
      logger.info(`Root channel renamed: ${name}`);
    }
  }

  /**
   * 记录用户状态变更日志
   */
  async logUserStateChange(log: {
     edge_id: number;
    actorSession: number;
    actorUsername: string;
    targetSession: number;
    targetUsername: string;
    changes: string;
  }): Promise<void> {
    const message = `User ${log.actorUsername} (session ${log.actorSession}) changed state of ${log.targetUsername} (session ${log.targetSession}): ${log.changes}`;

    await this.logAudit({
      type: 'user_state_change',
       edge_id: log.edge_id,
       session_id: log.actorSession,
      message,
      metadata: {
        actorSession: log.actorSession,
        actorUsername: log.actorUsername,
        targetSession: log.targetSession,
        targetUsername: log.targetUsername,
        changes: log.changes,
      },
    });

    logger.info(`[Audit] ${message}`);
  }

  /**
   * 记录用户踢出/封禁日志
   */
  async logUserRemove(log: {
     edge_id: number;
    actorSession: number;
    actorUsername: string;
    targetSession: number;
    targetUsername: string;
    isBan: boolean;
    reason?: string;
  }): Promise<void> {
    const action = log.isBan ? 'banned' : 'kicked';
    const message = `User ${log.actorUsername} (session ${log.actorSession}) ${action} ${log.targetUsername} (session ${log.targetSession})${log.reason ? `: ${log.reason}` : ''}`;

    await this.logAudit({
      type: log.isBan ? 'user_ban' : 'user_kick',
       edge_id: log.edge_id,
       session_id: log.actorSession,
      message,
      metadata: {
        actorSession: log.actorSession,
        actorUsername: log.actorUsername,
        targetSession: log.targetSession,
        targetUsername: log.targetUsername,
        action,
        reason: log.reason,
      },
    });

    logger.info(`[Audit] ${message}`);
  }

  /**
   * 记录频道操作日志
   */
  async logChannelOperation(log: {
     edge_id: number;
    actorSession: number;
    actorUsername: string;
    operation: 'create' | 'edit' | 'delete' | 'move';
     channel_id: number;
    channelName: string;
    details?: string;
  }): Promise<void> {
    const message = `User ${log.actorUsername} (session ${log.actorSession}) ${log.operation}d channel '${log.channelName}' (ID: ${log.channel_id})${log.details ? `: ${log.details}` : ''}`;

    await this.logAudit({
      type: `channel_${log.operation}`,
       edge_id: log.edge_id,
       session_id: log.actorSession,
      message,
      metadata: {
        actorSession: log.actorSession,
        actorUsername: log.actorUsername,
        operation: log.operation,
         channel_id: log.channel_id,
        channelName: log.channelName,
        details: log.details,
      },
    });

    logger.info(`[Audit] ${message}`);
  }

  /**
   * 记录ACL操作日志
   */
  async logACLOperation(log: {
     edge_id: number;
    actorSession: number;
    actorUsername: string;
     channel_id: number;
    channelName: string;
    operation: 'query' | 'update';
    details?: string;
  }): Promise<void> {
    const message = `User ${log.actorUsername} (session ${log.actorSession}) ${log.operation}ed ACL for channel '${log.channelName}' (ID: ${log.channel_id})${log.details ? `: ${log.details}` : ''}`;

    await this.logAudit({
      type: `acl_${log.operation}`,
       edge_id: log.edge_id,
       session_id: log.actorSession,
      message,
      metadata: {
        actorSession: log.actorSession,
        actorUsername: log.actorUsername,
         channel_id: log.channel_id,
        channelName: log.channelName,
        operation: log.operation,
        details: log.details,
      },
    });

    logger.info(`[Audit] ${message}`);
  }

  /**
   * 查询审计日志
   */
  async getAuditLogs(options: {
    eventType?: string;
    edge_id?: number;
    session_id?: number;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{
      id: number;
      event_type: string;
      edge_id: number | null;
      session_id: number | null;
      message: string;
      metadata: string | null;
      created_at: number;
    }>
  > {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: any[] = [];

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    }

    if (options.edge_id !== undefined) {
      query += ' AND edge_id = ?';
      params.push(options.edge_id);
    }

    if (options.session_id !== undefined) {
      query += ' AND session_id = ?';
      params.push(options.session_id);
    }

    if (options.startTime !== undefined) {
      query += ' AND created_at >= ?';
      params.push(options.startTime);
    }

    if (options.endTime !== undefined) {
      query += ' AND created_at <= ?';
      params.push(options.endTime);
    }

    query += ' ORDER BY created_at DESC';

    if (options.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = await this.db.prepare(query);
    return await stmt.all(...params);
  }

  // =====================================
  // 组管理方法
  // =====================================

  /**
   * 添加频道组
   */
  async addChannelGroup(channelGroup: Omit<ChannelGroupData, 'id'>): Promise<number> {
    const stmt = await this.db.prepare(`
      INSERT INTO channel_groups (channel_id, name, inherit, inheritable, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const result = await stmt.run(
      channelGroup.channel_id,
      channelGroup.name,
      channelGroup.inherit ? 1 : 0,
      channelGroup.inheritable ? 1 : 0
    );

    return result.lastID || 0;
  }

  /**
   * 更新频道组
   */
  async updateChannelGroup(id: number, updates: Partial<Omit<ChannelGroupData, 'id' | 'channel_id'>>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.inherit !== undefined) {
      fields.push('inherit = ?');
      values.push(updates.inherit ? 1 : 0);
    }
    if (updates.inheritable !== undefined) {
      fields.push('inheritable = ?');
      values.push(updates.inheritable ? 1 : 0);
    }

    if (fields.length === 0) {
      return;
    }

    fields.push("updated_at = datetime('now')");

    const stmt = await this.db.prepare(`
      UPDATE channel_groups SET ${fields.join(', ')} WHERE id = ?
    `);
    await stmt.run(...values, id);
  }

  /**
   * 删除频道组
   */
  async deleteChannelGroup(id: number): Promise<void> {
    const stmt = await this.db.prepare('DELETE FROM channel_groups WHERE id = ?');
    await stmt.run(id);
  }

  /**
   * 获取频道的所有频道组
   */
  async getChannelGroups(channel_id: number): Promise<ChannelGroupData[]> {
    const stmt = await this.db.prepare(`
      SELECT id, channel_id, name, inherit, inheritable
      FROM channel_groups
      WHERE channel_id = ?
      ORDER BY name
    `);

    const rows = await stmt.all(channel_id);
    return rows.map((row: any) => ({
      id: row.id,
      channel_id: row.channel_id,
      name: row.name,
      inherit: Boolean(row.inherit),
      inheritable: Boolean(row.inheritable),
    }));
  }

  /**
   * 获取特定频道组
   */
  async getChannelGroup(channel_id: number, channelGroupName: string): Promise<ChannelGroupData | null> {
    const stmt = await this.db.prepare(`
      SELECT id, channel_id, name, inherit, inheritable
      FROM channel_groups
      WHERE channel_id = ? AND name = ?
    `);

    const row = await stmt.get(channel_id, channelGroupName);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      channel_id: row.channel_id,
      name: row.name,
      inherit: Boolean(row.inherit),
      inheritable: Boolean(row.inheritable),
    };
  }

  /**
   * 清空频道的所有频道组
   */
  async clearChannelGroups(channel_id: number): Promise<void> {
    const stmt = await this.db.prepare('DELETE FROM channel_groups WHERE channel_id = ?');
    await stmt.run(channel_id);
  }

  /**
   * 添加频道组成员
   */
  async addChannelGroupMember(member: Omit<ChannelGroupMemberData, 'id'>): Promise<number> {
    const stmt = await this.db.prepare(`
      INSERT INTO channel_group_members (channel_group_id, user_id, is_add, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);

    const result = await stmt.run(
      member.channel_group_id,
      member.user_id,
      member.is_add ? 1 : 0
    );

    return result.lastID || 0;
  }

  /**
   * 获取频道组成员
   */
  async getChannelGroupMembers(channel_group_id: number): Promise<ChannelGroupMemberData[]> {
    const stmt = await this.db.prepare(`
      SELECT id, channel_group_id, user_id, is_add
      FROM channel_group_members
      WHERE channel_group_id = ?
    `);

    const rows = await stmt.all(channel_group_id);
    return rows.map((row: any) => ({
      id: row.id,
      channel_group_id: row.channel_group_id,
      user_id: row.user_id,
      is_add: Boolean(row.is_add),
    }));
  }

  /**
   * 清空频道组的特定类型成员（add 或 remove）
   */
  async clearChannelGroupMembers(channel_group_id: number, isAdd: boolean): Promise<void> {
    const stmt = await this.db.prepare(`
      DELETE FROM channel_group_members WHERE channel_group_id = ? AND is_add = ?
    `);
    await stmt.run(channel_group_id, isAdd ? 1 : 0);
  }

  /**
   * 获取频道层级（从根到当前频道）
   */
  async getChannelHierarchy(channel_id: number): Promise<number[]> {
    const hierarchy: number[] = [];
    let currentId = channel_id;

    while (currentId !== -1 && currentId !== null) {
      hierarchy.unshift(currentId);
      
      if (currentId === 0) {
        break;
      }

      const stmt = await this.db.prepare('SELECT parent_id FROM channels WHERE id = ?');
      const row = await stmt.get(currentId);
      
      if (!row) {
        break;
      }

      currentId = row.parent_id;
    }

    return hierarchy;
  }

  // ====================
  // Blob 相关方法
  // ====================

  /**
   * 获取用户的 texture blob hash
   */
  async getUserTextureBlob(user_id: number): Promise<string | null> {
    const stmt = await this.db.prepare('SELECT texture_blob FROM users WHERE id = ?');
    const row = await stmt.get(user_id);
    return row?.texture_blob || null;
  }

  /**
   * 设置用户的 texture blob hash
   */
  async setUserTextureBlob(user_id: number, blobHash: string | null): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT INTO users (id, name, texture_blob, updated_at)
      VALUES (?, 'user_' || ?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET texture_blob = ?, updated_at = strftime('%s', 'now')
    `);
    await stmt.run(user_id, user_id, blobHash, blobHash);
  }

  /**
   * 获取用户的 comment blob hash
   */
  async getUserCommentBlob(user_id: number): Promise<string | null> {
    const stmt = await this.db.prepare('SELECT comment_blob FROM users WHERE id = ?');
    const row = await stmt.get(user_id);
    return row?.comment_blob || null;
  }

  /**
   * 设置用户的 comment blob hash
   */
  async setUserCommentBlob(user_id: number, blobHash: string | null): Promise<void> {
    const stmt = await this.db.prepare(`
      INSERT INTO users (id, name, comment_blob, updated_at)
      VALUES (?, 'user_' || ?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET comment_blob = ?, updated_at = strftime('%s', 'now')
    `);
    await stmt.run(user_id, user_id, blobHash, blobHash);
  }

  /**
   * 获取频道的 description blob hash
   */
  async getChannelDescriptionBlob(channel_id: number): Promise<string | null> {
    const stmt = await this.db.prepare('SELECT description_blob FROM channels WHERE id = ?');
    const row = await stmt.get(channel_id);
    return row?.description_blob || null;
  }

  /**
   * 设置频道的 description blob hash
   */
  async setChannelDescriptionBlob(channel_id: number, blobHash: string | null): Promise<void> {
    const stmt = await this.db.prepare(`
      UPDATE channels SET description_blob = ? WHERE id = ?
    `);
    await stmt.run(blobHash, channel_id);
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    await this.db.close();
    logger.info('Database connection closed');
  }
}
