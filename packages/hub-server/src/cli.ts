#!/usr/bin/env node

import { loadConfig } from '@munode/common';
import { HubServer } from './hub-server.js';
import type { HubConfig } from './types.js';

async function main() {
  const configPath = process.argv[2] || './config/hub.json';

  try {
    const config = await loadConfig<HubConfig>(configPath);

    const server = new HubServer(config);
    await server.start();

    // 优雅关闭
    process.on('SIGINT', async () => {
      console.log('\nShutting down Hub Server...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down Hub Server...');
      await server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start Hub Server:', error);
    process.exit(1);
  }
}

main();
