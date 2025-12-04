/**
 * Test channel persistence after Hub restart
 */

import { HubServer } from './packages/hub-server/dist/index.js';
import { promises as fs } from 'fs';

async function testChannelPersistence() {
  console.log('=== Testing Channel Persistence ===\n');
  
  const dbPath = '/tmp/test-hub-persistence.db';
  const backupDir = '/tmp/test-backups';
  
  // Clean up old files
  try {
    await fs.unlink(dbPath);
    console.log('Removed old database');
  } catch (e) {
    // ignore
  }
  
  try {
    await fs.rm(backupDir, { recursive: true });
  } catch (e) {
    // ignore
  }
  
  // Test config - complete configuration
  const config = {
    name: 'Test Hub Server',
    server_id: 1,
    host: 'localhost',
    port: 9999,
    controlPort: 9998,
    database: {
      path: dbPath,
      backupDir: backupDir,
      backupInterval: 3600000,
    },
    registry: {
      enableAuth: false,
      hmacSecret: 'test-secret',
      heartbeatInterval: 30000,
      heartbeatTimeout: 60000,
    },
    blobStore: {
      enabled: false,
      path: '/tmp/blobs',
    },
    tls: {
      enabled: false,
    },
    webApi: {
      enabled: false,
    },
    auth: {
      apiUrl: null,
    },
  };
  
  console.log('Step 1: Creating Hub Server and initializing...');
  const hub1 = new HubServer(config);
  await hub1.init();
  await hub1.start();
  console.log('✓ Hub Server started\n');
  
  // Get the database from internal state
  console.log('Step 2: Creating test channels via database...');
  const database = hub1.database;
  
  const lobbyId = await database.createChannel({
    name: 'Lobby',
    position: 0,
    parent_id: 0,
    inherit_acl: true,
  });
  console.log(`✓ Created channel "Lobby" with ID ${lobbyId}`);
  
  const generalId = await database.createChannel({
    name: 'General',
    position: 1,
    parent_id: 0,
    inherit_acl: true,
  });
  console.log(`✓ Created channel "General" with ID ${generalId}`);
  
  const privateId = await database.createChannel({
    name: 'Private',
    position: 2,
    parent_id: 0,
    inherit_acl: false,
  });
  console.log(`✓ Created channel "Private" with ID ${privateId}\n`);
  
  // Verify channels are in database
  console.log('Step 3: Verifying channels in database...');
  const channels1 = await database.getAllChannels();
  console.log(`✓ Found ${channels1.length} channels in database`);
  console.log('  Channels:', channels1.map(ch => `${ch.id}:${ch.name}`).join(', '));
  
  if (channels1.length < 4) { // Root + 3 test channels
    console.error('✗ FAILED: Expected at least 4 channels in database');
    await hub1.stop();
    process.exit(1);
  }
  console.log('');
  
  console.log('Step 4: Stopping Hub Server...');
  await hub1.stop();
  console.log('✓ Hub Server stopped\n');
  
  // Wait a bit to ensure everything is closed
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('Step 5: Restarting Hub Server...');
  const hub2 = new HubServer(config);
  await hub2.init();
  await hub2.start();
  console.log('✓ Hub Server restarted\n');
  
  // Check if channels are loaded
  console.log('Step 6: Verifying channels after restart...');
  const database2 = hub2.database;
  const channels2 = await database2.getAllChannels();
  console.log(`✓ Found ${channels2.length} channels in database after restart`);
  console.log('  Channels:', channels2.map(ch => `${ch.id}:${ch.name}`).join(', '));
  
  if (channels2.length < 4) {
    console.error('✗ FAILED: Channels not persisted across restart');
    await hub2.stop();
    process.exit(1);
  }
  
  // Verify specific channels exist
  const hasLobby = channels2.some(ch => ch.name === 'Lobby' && ch.id === lobbyId);
  const hasGeneral = channels2.some(ch => ch.name === 'General' && ch.id === generalId);
  const hasPrivate = channels2.some(ch => ch.name === 'Private' && ch.id === privateId);
  
  if (!hasLobby || !hasGeneral || !hasPrivate) {
    console.error('✗ FAILED: Not all channels were persisted correctly');
    console.error(`  Lobby: ${hasLobby}, General: ${hasGeneral}, Private: ${hasPrivate}`);
    await hub2.stop();
    process.exit(1);
  }
  console.log('✓ All test channels persisted correctly\n');
  
  console.log('Step 7: Stopping Hub Server...');
  await hub2.stop();
  console.log('✓ Hub Server stopped\n');
  
  console.log('=== ALL TESTS PASSED ===');
  process.exit(0);
}

testChannelPersistence().catch((error) => {
  console.error('Test failed with error:', error);
  process.exit(1);
});
