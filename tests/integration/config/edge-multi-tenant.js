/**
 * 多租户集成测试配置
 */

export default {
  server_id: 1,
  name: 'Multi-Tenant Test Edge Server',
  mode: 'cluster',
  
  network: {
    host: '127.0.0.1',
    port: 64740, // 使用不同端口避免冲突
    external_host: 'localhost',
  },
  
  tls: {
    cert: 'tests/integration/certs/server.pem',
    key: 'tests/integration/certs/server.key',
    require_client_cert: false,
    reject_unauthorized: false,
  },
  
  hub_server: {
    host: '127.0.0.1',
    port: 9081,
    control_port: 11081,
    tls: {
      reject_unauthorized: false,
    },
    connection_type: 'websocket',
    reconnect_interval: 5000,
    heartbeat_interval: 30000,
    pool_size: 2,
  },
  
  voice_routing: {
    enabled: true,
  },
  
  server: {
    capacity: 100,
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
    ban_system: false,
    context_actions: false,
    packet_pool: true,
    udp_monitor: false,
    allow_ping: true,
    allow_html: true,
  },
  
  log_level: 'debug',
  
  // 多租户配置
  virtualHosts: [
    {
      servername: 'server1.localhost',
      server_id: 101,
      name: 'Test Server 1',
      tls: {
        cert: 'tests/integration/certs/server.pem',
        key: 'tests/integration/certs/server.key',
        require_client_cert: false,
        reject_unauthorized: false,
      },
      welcomeText: 'Welcome to Test Server 1',
      maxUsers: 50,
      defaultChannel: 0,
    },
    {
      servername: 'server2.localhost',
      server_id: 102,
      name: 'Test Server 2',
      tls: {
        cert: 'tests/integration/certs/server2.pem',
        key: 'tests/integration/certs/server2.key',
        require_client_cert: false,
        reject_unauthorized: false,
      },
      welcomeText: 'Welcome to Test Server 2',
      maxUsers: 50,
      defaultChannel: 0,
    },
    {
      servername: 'server3.localhost',
      server_id: 103,
      name: 'Test Server 3',
      tls: {
        cert: 'tests/integration/certs/server3.pem',
        key: 'tests/integration/certs/server3.key',
        require_client_cert: false,
        reject_unauthorized: false,
      },
      welcomeText: 'Welcome to Test Server 3',
      maxUsers: 50,
      defaultChannel: 0,
    },
  ],
  
  defaultVirtualHost: 'server1.localhost',
};
