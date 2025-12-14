/**
 * Utility functions for channel operations
 */

import type { HubChannelData } from '../channel-manager.js';

/**
 * Get channel ID from either HubChannelData or database channel object
 * Handles the transition from id to channel_id
 */
export function getChannelId(channel: HubChannelData | { id: number; [key: string]: unknown }): number {
  if ('channel_id' in channel && typeof channel.channel_id === 'number') {
    return channel.channel_id;
  }
  if ('id' in channel && typeof channel.id === 'number') {
    return channel.id;
  }
  throw new Error('Channel object has neither channel_id nor id property');
}
