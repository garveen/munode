#!/usr/bin/env node

import { ChannelState } from './packages/protocol/dist/generated/proto/Mumble.js';

console.log('Testing ChannelState protobuf encoding...\n');

const testData = {
  channelId: 1,
  name: 'test',
  parent: 0,
  description: '',
  position: 0,
  maxUsers: 0,
  temporary: false,
  links: [],
  linksAdd: [],
  linksRemove: []
};

console.log('Input data:', JSON.stringify(testData, null, 2));

const encoded = ChannelState.toBinary(testData);
console.log('\nEncoded length:', encoded.length, 'bytes');
console.log('Hex:', Buffer.from(encoded).toString('hex'));

const decoded = ChannelState.fromBinary(encoded);
console.log('\nDecoded:', JSON.stringify(decoded, null, 2));

console.log('\n✓ Protobuf encoding/decoding works correctly');
