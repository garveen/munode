import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VirtualHostManager, SecureContextManager, validateAndParseEdgeConfig } from '@munode/edge-server';
import { createLogger } from '@munode/common';
import fs from 'fs/promises';
import path from 'path';

describe('多租户 SNI 集成测试', () => {
  const logger = createLogger({ level: 'silent', service: 'test' });
  let config: any;
  let vhostManager: VirtualHostManager;
  let secureContextManager: SecureContextManager;

  beforeAll(async () => {
    // 加载多租户测试配置
    const configPath = path.join(process.cwd(), 'tests/integration/config/edge-multi-tenant.js');
    const configModule = await import(configPath);
    const rawConfig = configModule.default;
    config = validateAndParseEdgeConfig(rawConfig);
    
    // 初始化虚拟主机管理器
    vhostManager = new VirtualHostManager(config, logger);
    
    // 初始化证书管理器
    secureContextManager = new SecureContextManager(logger);
  });

  afterAll(async () => {
    await vhostManager.cleanup();
    secureContextManager.clear();
  });

  describe('VirtualHostManager 集成', () => {
    it('应该加载所有虚拟主机', () => {
      expect(vhostManager.getHostCount()).toBe(3);
      expect(vhostManager.isMultiTenant()).toBe(true);
      
      const hostNames = vhostManager.getHostNames();
      expect(hostNames).toContain('server1.localhost');
      expect(hostNames).toContain('server2.localhost');
      expect(hostNames).toContain('server3.localhost');
    });

    it('应该能够根据域名查找虚拟主机', () => {
      const host1 = vhostManager.getHost('server1.localhost');
      expect(host1.config.server_id).toBe(101);
      expect(host1.config.name).toBe('Test Server 1');
      
      const host2 = vhostManager.getHost('server2.localhost');
      expect(host2.config.server_id).toBe(102);
      
      const host3 = vhostManager.getHost('server3.localhost');
      expect(host3.config.server_id).toBe(103);
    });

    it('应该在未找到时返回默认主机', () => {
      const host = vhostManager.getHost('unknown.localhost');
      expect(host.config.servername).toBe('server1.localhost');
    });

    it('每个虚拟主机应该有独立的 ClientManager', () => {
      const host1 = vhostManager.getHost('server1.localhost');
      const host2 = vhostManager.getHost('server2.localhost');
      
      expect(host1.clientManager).not.toBe(host2.clientManager);
    });
  });

  describe('SecureContextManager 集成', () => {
    it('应该能够为虚拟主机加载证书', async () => {
      const host1 = vhostManager.getHost('server1.localhost');
      const host2 = vhostManager.getHost('server2.localhost');
      const host3 = vhostManager.getHost('server3.localhost');
      
      // 加载证书
      await secureContextManager.createContext(host1.config);
      await secureContextManager.createContext(host2.config);
      await secureContextManager.createContext(host3.config);
      
      const loadedHosts = secureContextManager.getLoadedHosts();
      expect(loadedHosts).toHaveLength(3);
      expect(loadedHosts).toContain('server1.localhost');
      expect(loadedHosts).toContain('server2.localhost');
      expect(loadedHosts).toContain('server3.localhost');
    });

    it('应该能够根据域名获取 SecureContext', async () => {
      const host1 = vhostManager.getHost('server1.localhost');
      await secureContextManager.createContext(host1.config);
      
      const context = secureContextManager.getContext('server1.localhost');
      expect(context).not.toBeNull();
    });

    it('未找到证书时应该返回 null', () => {
      const context = secureContextManager.getContext('nonexistent.localhost');
      expect(context).toBeNull();
    });

    it('应该能够重新加载证书', async () => {
      const host1 = vhostManager.getHost('server1.localhost');
      await secureContextManager.createContext(host1.config);
      
      // 重新加载
      await secureContextManager.reloadContext(host1.config);
      
      const context = secureContextManager.getContext('server1.localhost');
      expect(context).not.toBeNull();
    });
  });

  describe('证书文件验证', () => {
    it('所有配置的证书文件应该存在', async () => {
      const hosts = [
        vhostManager.getHost('server1.localhost'),
        vhostManager.getHost('server2.localhost'),
        vhostManager.getHost('server3.localhost'),
      ];
      
      for (const host of hosts) {
        const certPath = path.join(process.cwd(), host.config.tls.cert);
        const keyPath = path.join(process.cwd(), host.config.tls.key);
        
        const [certExists, keyExists] = await Promise.all([
          fs.access(certPath).then(() => true).catch(() => false),
          fs.access(keyPath).then(() => true).catch(() => false),
        ]);
        
        expect(certExists).toBe(true);
        expect(keyExists).toBe(true);
      }
    });

    it('证书文件应该可读', async () => {
      const host1 = vhostManager.getHost('server1.localhost');
      const certPath = path.join(process.cwd(), host1.config.tls.cert);
      const keyPath = path.join(process.cwd(), host1.config.tls.key);
      
      const [cert, key] = await Promise.all([
        fs.readFile(certPath, 'utf-8'),
        fs.readFile(keyPath, 'utf-8'),
      ]);
      
      expect(cert).toContain('BEGIN CERTIFICATE');
      expect(key).toContain('BEGIN PRIVATE KEY');
    });
  });

  describe('配置验证', () => {
    it('配置应该包含 virtualHosts', () => {
      expect(config.virtualHosts).toBeDefined();
      expect(Array.isArray(config.virtualHosts)).toBe(true);
      expect(config.virtualHosts).toHaveLength(3);
    });

    it('配置应该包含 defaultVirtualHost', () => {
      expect(config.defaultVirtualHost).toBe('server1.localhost');
    });

    it('每个虚拟主机应该有唯一的 server_id', () => {
      const serverIds = config.virtualHosts.map((vh: any) => vh.server_id);
      const uniqueIds = new Set(serverIds);
      expect(uniqueIds.size).toBe(serverIds.length);
    });

    it('每个虚拟主机应该有唯一的 servername', () => {
      const servernames = config.virtualHosts.map((vh: any) => vh.servername);
      const uniqueNames = new Set(servernames);
      expect(uniqueNames.size).toBe(servernames.length);
    });
  });
});
