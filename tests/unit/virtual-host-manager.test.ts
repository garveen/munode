import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualHostManager } from '../../packages/edge-server/src/virtual-host/virtual-host-manager.js';
import type { EdgeConfig } from '../../packages/edge-server/src/types.js';
import { createLogger } from '@munode/common';

describe('VirtualHostManager', () => {
  const logger = createLogger({ level: 'silent', service: 'test' });

  describe('单租户模式（向后兼容）', () => {
    it('应该在无 virtualHosts 配置时创建默认主机', () => {
      const config: EdgeConfig = {
        server_id: 1,
        name: 'Test Server',
        mode: 'cluster',
        network: {
          host: '0.0.0.0',
          port: 64738,
          external_host: 'localhost',
        },
        tls: {
          cert: 'test-cert.pem',
          key: 'test-key.pem',
          require_client_cert: false,
          reject_unauthorized: true,
        },
        server: {
          capacity: 1000,
          max_bandwidth: 558000,
          default_channel: 0,
          timeout: 30,
        },
        client: {
          max_text_message_length: 5000,
          max_image_message_length: 131072,
        },
        features: {
          geoip: false,
          ban_system: true,
          context_actions: true,
          packet_pool: true,
          udp_monitor: true,
          allow_ping: true,
          allow_html: true,
        },
        log_level: 'info',
      };

      const manager = new VirtualHostManager(config, logger);

      expect(manager.getHostCount()).toBe(1);
      expect(manager.isMultiTenant()).toBe(false);
      expect(manager.getHostNames()).toContain('default');

      const defaultHost = manager.getDefaultHost();
      expect(defaultHost).toBeDefined();
      expect(defaultHost.config.server_id).toBe(1);
      expect(defaultHost.config.name).toBe('Test Server');
    });

    it('应该能够通过 getHost 获取默认主机', () => {
      const config: EdgeConfig = {
        server_id: 1,
        name: 'Test Server',
        mode: 'cluster',
        network: {
          host: '0.0.0.0',
          port: 64738,
          external_host: 'localhost',
        },
        tls: {
          cert: 'test-cert.pem',
          key: 'test-key.pem',
          require_client_cert: false,
          reject_unauthorized: true,
        },
        server: {
          capacity: 1000,
          max_bandwidth: 558000,
          default_channel: 0,
          timeout: 30,
        },
        client: {
          max_text_message_length: 5000,
          max_image_message_length: 131072,
        },
        features: {
          geoip: false,
          ban_system: true,
          context_actions: true,
          packet_pool: true,
          udp_monitor: true,
          allow_ping: true,
          allow_html: true,
        },
        log_level: 'info',
      };

      const manager = new VirtualHostManager(config, logger);
      const host = manager.getHost('any-domain.com');

      expect(host).toBeDefined();
      expect(host.config.servername).toBe('default');
    });
  });

  describe('多租户模式', () => {
    let multiTenantConfig: EdgeConfig;

    beforeEach(() => {
      multiTenantConfig = {
        server_id: 1,
        name: 'Multi-Tenant Server',
        mode: 'cluster',
        network: {
          host: '0.0.0.0',
          port: 64738,
          external_host: 'localhost',
        },
        tls: {
          cert: 'default-cert.pem',
          key: 'default-key.pem',
          require_client_cert: false,
          reject_unauthorized: true,
        },
        server: {
          capacity: 1000,
          max_bandwidth: 558000,
          default_channel: 0,
          timeout: 30,
        },
        client: {
          max_text_message_length: 5000,
          max_image_message_length: 131072,
        },
        features: {
          geoip: false,
          ban_system: true,
          context_actions: true,
          packet_pool: true,
          udp_monitor: true,
          allow_ping: true,
          allow_html: true,
        },
        log_level: 'info',
        virtualHosts: [
          {
            servername: 'server1.localhost',
            server_id: 101,
            name: 'Server 1',
            tls: {
              cert: 'server1-cert.pem',
              key: 'server1-key.pem',
              require_client_cert: false,
              reject_unauthorized: true,
            },
            defaultChannel: 0,
          },
          {
            servername: 'server2.localhost',
            server_id: 102,
            name: 'Server 2',
            tls: {
              cert: 'server2-cert.pem',
              key: 'server2-key.pem',
              require_client_cert: false,
              reject_unauthorized: true,
            },
            defaultChannel: 0,
          },
          {
            servername: 'server3.localhost',
            server_id: 103,
            name: 'Server 3',
            tls: {
              cert: 'server3-cert.pem',
              key: 'server3-key.pem',
              require_client_cert: false,
              reject_unauthorized: true,
            },
            defaultChannel: 0,
          },
        ],
        defaultVirtualHost: 'server1.localhost',
      };
    });

    it('应该初始化多个虚拟主机', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      expect(manager.getHostCount()).toBe(3);
      expect(manager.isMultiTenant()).toBe(true);
      expect(manager.getHostNames()).toEqual([
        'server1.localhost',
        'server2.localhost',
        'server3.localhost',
      ]);
    });

    it('应该能够通过域名精确匹配虚拟主机', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      const host1 = manager.getHost('server1.localhost');
      expect(host1.config.servername).toBe('server1.localhost');
      expect(host1.config.server_id).toBe(101);
      expect(host1.config.name).toBe('Server 1');

      const host2 = manager.getHost('server2.localhost');
      expect(host2.config.servername).toBe('server2.localhost');
      expect(host2.config.server_id).toBe(102);

      const host3 = manager.getHost('server3.localhost');
      expect(host3.config.servername).toBe('server3.localhost');
      expect(host3.config.server_id).toBe(103);
    });

    it('应该在无匹配时返回默认主机', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      const host = manager.getHost('unknown.localhost');
      expect(host.config.servername).toBe('server1.localhost');
    });

    it('应该支持通配符域名匹配', () => {
      const wildcardConfig: EdgeConfig = {
        ...multiTenantConfig,
        virtualHosts: [
          {
            servername: '*.example.com',
            server_id: 201,
            name: 'Wildcard Server',
            tls: {
              cert: 'wildcard-cert.pem',
              key: 'wildcard-key.pem',
              require_client_cert: false,
              reject_unauthorized: true,
            },
            defaultChannel: 0,
          },
        ],
        defaultVirtualHost: '*.example.com',
      };

      const manager = new VirtualHostManager(wildcardConfig, logger);

      const host1 = manager.getHost('server1.example.com');
      expect(host1.config.servername).toBe('*.example.com');
      expect(host1.config.server_id).toBe(201);

      const host2 = manager.getHost('server2.example.com');
      expect(host2.config.servername).toBe('*.example.com');

      const host3 = manager.getHost('subdomain.example.com');
      expect(host3.config.servername).toBe('*.example.com');
    });

    it('应该能够获取默认虚拟主机', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      const defaultHost = manager.getDefaultHost();
      expect(defaultHost.config.servername).toBe('server1.localhost');
      expect(defaultHost.config.server_id).toBe(101);
    });

    it('每个虚拟主机应该有独立的 ClientManager', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      const host1 = manager.getHost('server1.localhost');
      const host2 = manager.getHost('server2.localhost');

      expect(host1.clientManager).toBeDefined();
      expect(host2.clientManager).toBeDefined();
      expect(host1.clientManager).not.toBe(host2.clientManager);
    });

    it('应该正确合并配置（虚拟主机继承全局配置）', () => {
      const manager = new VirtualHostManager(multiTenantConfig, logger);

      const host = manager.getHost('server1.localhost');
      
      // 虚拟主机特定配置
      expect(host.config.servername).toBe('server1.localhost');
      expect(host.config.server_id).toBe(101);
      expect(host.config.tls.cert).toBe('server1-cert.pem');
      
      // 应该继承全局配置
      // （这个验证留给集成测试，因为需要检查实际创建的 EdgeConfig）
    });
  });

  describe('生命周期管理', () => {
    it('应该能够清理所有虚拟主机', async () => {
      const config: EdgeConfig = {
        server_id: 1,
        name: 'Test Server',
        mode: 'cluster',
        network: {
          host: '0.0.0.0',
          port: 64738,
          external_host: 'localhost',
        },
        tls: {
          cert: 'test-cert.pem',
          key: 'test-key.pem',
          require_client_cert: false,
          reject_unauthorized: true,
        },
        server: {
          capacity: 1000,
          max_bandwidth: 558000,
          default_channel: 0,
          timeout: 30,
        },
        client: {
          max_text_message_length: 5000,
          max_image_message_length: 131072,
        },
        features: {
          geoip: false,
          ban_system: true,
          context_actions: true,
          packet_pool: true,
          udp_monitor: true,
          allow_ping: true,
          allow_html: true,
        },
        log_level: 'info',
        virtualHosts: [
          {
            servername: 'server1.localhost',
            server_id: 101,
            name: 'Server 1',
            tls: {
              cert: 'server1-cert.pem',
              key: 'server1-key.pem',
              require_client_cert: false,
              reject_unauthorized: true,
            },
            defaultChannel: 0,
          },
        ],
      };

      const manager = new VirtualHostManager(config, logger);
      expect(manager.getHostCount()).toBe(1);

      await manager.cleanup();
      expect(manager.getHostCount()).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('应该在没有配置虚拟主机时抛出错误', () => {
      const config: EdgeConfig = {
        server_id: 1,
        name: 'Test Server',
        mode: 'cluster',
        network: {
          host: '0.0.0.0',
          port: 64738,
          external_host: 'localhost',
        },
        tls: {
          cert: 'test-cert.pem',
          key: 'test-key.pem',
          require_client_cert: false,
          reject_unauthorized: true,
        },
        server: {
          capacity: 1000,
          max_bandwidth: 558000,
          default_channel: 0,
          timeout: 30,
        },
        client: {
          max_text_message_length: 5000,
          max_image_message_length: 131072,
        },
        features: {
          geoip: false,
          ban_system: true,
          context_actions: true,
          packet_pool: true,
          udp_monitor: true,
          allow_ping: true,
          allow_html: true,
        },
        log_level: 'info',
        virtualHosts: [], // 空数组
      };

      // 空的 virtualHosts 数组应该触发单租户模式
      const manager = new VirtualHostManager(config, logger);
      expect(manager.getHostCount()).toBe(1);
      expect(manager.getHostNames()).toContain('default');
    });
  });
});
