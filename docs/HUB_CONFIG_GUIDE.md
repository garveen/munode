# Hub Server Configuration Guide

This document describes all available configuration options for the MuNode Hub Server.

## Table of Contents

- [Basic Configuration](#basic-configuration)
- [Network Configuration](#network-configuration)
- [User & Channel Limits](#user--channel-limits)
- [Bandwidth & Message Limits](#bandwidth--message-limits)
- [Security & Authentication](#security--authentication)
- [Auto-Ban System](#auto-ban-system)
- [Channel Behavior](#channel-behavior)
- [Welcome Messages](#welcome-messages)
- [Client Suggestions](#client-suggestions)
- [Server Registration & Discovery](#server-registration--discovery)
- [Listener Features](#listener-features)
- [Advanced Features](#advanced-features)
- [TLS Configuration](#tls-configuration)
- [Registry Configuration](#registry-configuration)
- [Database Configuration](#database-configuration)
- [Blob Storage Configuration](#blob-storage-configuration)
- [Web API Configuration](#web-api-configuration)
- [Logging Configuration](#logging-configuration)

## Basic Configuration

### `server_id` (required)
- **Type**: `number`
- **Description**: Unique identifier for this Hub server in the cluster
- **Example**: `0`

### `name` (required)
- **Type**: `string`
- **Description**: Internal name of the Hub server
- **Example**: `"MuNode Hub Server"`

### `registerName` (optional)
- **Type**: `string`
- **Description**: Public display name for the Root channel
- **Default**: `"Root"`
- **Example**: `"MuNode Server"`

### `host` (required)
- **Type**: `string`
- **Description**: IP address to bind the server to
- **Example**: `"0.0.0.0"` (all interfaces) or `"127.0.0.1"` (localhost only)

### `port` (required)
- **Type**: `number`
- **Description**: Port number for the Hub server
- **Range**: `1-65535`
- **Example**: `65000`

### `controlPort` (optional)
- **Type**: `number`
- **Description**: Port for control channel communication
- **Example**: `11080`

### `voicePort` (optional)
- **Type**: `number`
- **Description**: Port for voice channel communication
- **Example**: `9089`

## Network Configuration

### `timeout` (optional)
- **Type**: `number`
- **Description**: Client connection timeout in seconds
- **Default**: `30`
- **Example**: `60`

### `serverPassword` (optional)
- **Type**: `string`
- **Description**: Password required to connect to the server
- **Default**: `undefined` (no password)
- **Example**: `"my-secure-password"`
- **Security Note**: If not set, a warning will be logged

## User & Channel Limits

### `maxUsers` (optional)
- **Type**: `number`
- **Description**: Maximum number of users allowed on the server
- **Default**: `1000`
- **Minimum**: `1`
- **Example**: `500`

### `maxUsersPerChannel` (optional)
- **Type**: `number`
- **Description**: Maximum number of users per channel
- **Default**: `0` (unlimited)
- **Example**: `50`
- **Note**: `0` means unlimited

### `channelNestingLimit` (optional)
- **Type**: `number`
- **Description**: Maximum depth of channel nesting
- **Default**: `10`
- **Minimum**: `1`
- **Example**: `15`
- **Purpose**: Prevents infinite nesting attacks

### `channelCountLimit` (optional)
- **Type**: `number`
- **Description**: Maximum total number of channels
- **Default**: `1000`
- **Minimum**: `1`
- **Example**: `5000`
- **Purpose**: Prevents channel creation abuse

## Bandwidth & Message Limits

### `bandwidth` (optional)
- **Type**: `number`
- **Description**: Maximum bandwidth per user in bits per second
- **Default**: `558000` (558 Kbps)
- **Example**: `1000000` (1 Mbps)
- **Purpose**: Prevents bandwidth abuse

### `textMessageLength` (optional)
- **Type**: `number`
- **Description**: Maximum length of text messages in characters
- **Default**: `5000`
- **Example**: `10000`

### `imageMessageLength` (optional)
- **Type**: `number`
- **Description**: Maximum size of image messages in bytes
- **Default**: `131072` (128 KB)
- **Example**: `262144` (256 KB)

### `messageLimit` (optional)
- **Type**: `number`
- **Description**: Message rate limit in messages per second
- **Default**: `1`
- **Example**: `2`
- **Purpose**: Prevents message flooding

### `messageBurst` (optional)
- **Type**: `number`
- **Description**: Message burst capacity (token bucket algorithm)
- **Default**: `5`
- **Example**: `10`
- **Purpose**: Allows short bursts of messages while maintaining rate limit

### `pluginMessageLimit` (optional)
- **Type**: `number`
- **Description**: Plugin message rate limit in messages per second
- **Default**: `4`
- **Example**: `8`

### `pluginMessageBurst` (optional)
- **Type**: `number`
- **Description**: Plugin message burst capacity
- **Default**: `15`
- **Example**: `20`

## Security & Authentication

### `kdfIterations` (optional)
- **Type**: `number`
- **Description**: PBKDF2 key derivation function iterations for password hashing
- **Default**: `-1` (auto-benchmark for ~100ms)
- **Example**: `100000`
- **Note**: `-1` performs automatic benchmarking, values < 100000 will trigger a warning

### `allowHTML` (optional)
- **Type**: `boolean`
- **Description**: Allow HTML in text messages
- **Default**: `true`
- **Warning**: When enabled, HTML filtering must be implemented to prevent XSS attacks
- **Example**: `false`

### `forceExternalAuth` (optional)
- **Type**: `boolean`
- **Description**: Force users to authenticate via external authentication system
- **Default**: `false`
- **Example**: `true`
- **See**: [External Authentication Configuration](./EXTERNAL_AUTH_CONFIGURATION.md) for detailed setup

### `auth` (optional)
- **Type**: `object`
- **Description**: External authentication configuration
- **Default**: `undefined` (no external authentication)
- **See**: [External Authentication Configuration](./EXTERNAL_AUTH_CONFIGURATION.md) for complete documentation

#### `auth.apiUrl`
- **Type**: `string`
- **Description**: External authentication API URL
- **Example**: `"https://auth.example.com/api/authenticate"`

#### `auth.apiKey`
- **Type**: `string`
- **Description**: API key for authentication server
- **Example**: `"your-secret-api-key"`

#### `auth.timeout`
- **Type**: `number`
- **Description**: Authentication request timeout in milliseconds
- **Default**: `5000`
- **Example**: `10000`

#### `auth.contentType`
- **Type**: `"application/json" | "application/x-www-form-urlencoded"`
- **Description**: HTTP request body content type
- **Default**: `"application/json"`
- **Example**: `"application/x-www-form-urlencoded"`
- **Note**: Use `"application/x-www-form-urlencoded"` for legacy authentication servers

#### `auth.headers`
- **Type**: `object`
- **Description**: Custom authentication headers configuration

**Example:**
```json
"auth": {
  "apiUrl": "https://auth.myserver.com/authenticate",
  "apiKey": "secret-key",
  "timeout": 5000,
  "contentType": "application/json",
  "headers": {
    "authHeaderName": "X-API-Token",
    "authHeaderFormat": "Bearer {apiKey}"
  },
  "responseFields": {
    "successField": "success",
    "userIdField": "user_id",
    "usernameField": "username"
  },
  "cacheTTL": 300000,
  "allowCacheFallback": true
}
```

### `sslCiphers` (optional)
- **Type**: `string`
- **Description**: SSL/TLS cipher suite configuration
- **Example**: `"HIGH:!aNULL:!MD5"`

### `usernameRegex` (optional)
- **Type**: `string`
- **Description**: Regular expression for validating usernames
- **Default**: `"[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+"`
- **Example**: `"^[a-zA-Z0-9_-]+$"` (alphanumeric, underscore, hyphen only)

### `channelNameRegex` (optional)
- **Type**: `string`
- **Description**: Regular expression for validating channel names
- **Default**: `"[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+"`
- **Example**: `"^[a-zA-Z0-9_-]+$"`

## Auto-Ban System

### `autoBan` (optional)
- **Type**: `object`
- **Description**: Configuration for automatic banning of abusive clients
- **Default**: See individual fields below

#### `autoBan.attempts`
- **Type**: `number`
- **Description**: Number of failed connection attempts before auto-ban
- **Default**: `10`
- **Minimum**: `1`
- **Example**: `5`

#### `autoBan.timeframe`
- **Type**: `number`
- **Description**: Time window in seconds for counting failed attempts
- **Default**: `120`
- **Example**: `300`

#### `autoBan.duration`
- **Type**: `number`
- **Description**: Duration of the ban in seconds
- **Default**: `300`
- **Example**: `600`

#### `autoBan.banSuccessfulConnections`
- **Type**: `boolean`
- **Description**: Reset failed attempt counter after successful connection
- **Default**: `true`
- **Example**: `false`

**Example Configuration:**
```json
"autoBan": {
  "attempts": 10,
  "timeframe": 120,
  "duration": 300,
  "banSuccessfulConnections": true
}
```

## Channel Behavior

### `defaultChannel` (optional)
- **Type**: `number`
- **Description**: Default channel ID for new users
- **Default**: `0` (Root channel)
- **Example**: `5`

### `rememberChannel` (optional)
- **Type**: `boolean`
- **Description**: Remember the last channel a user was in
- **Default**: `true`
- **Example**: `false`

### `rememberChannelDuration` (optional)
- **Type**: `number`
- **Description**: How long to remember the channel in seconds
- **Default**: `0` (remember forever)
- **Example**: `86400` (1 day)
- **Note**: `0` means permanent memory

## Welcome Messages

### `welcomeText` (optional)
- **Type**: `string`
- **Description**: Welcome message displayed to users when they connect
- **Example**: `"Welcome to our Mumble server!"`

### `welcomeTextFile` (optional)
- **Type**: `string`
- **Description**: Path to a file containing the welcome message
- **Example**: `"./config/welcome.txt"`
- **Note**: If both `welcomeText` and `welcomeTextFile` are set, `welcomeTextFile` takes precedence

## Client Suggestions

### `suggest` (optional)
- **Type**: `object`
- **Description**: Suggestions sent to connecting clients

#### `suggest.version`
- **Type**: `string`
- **Description**: Suggested client version
- **Format**: `"major.minor.patch"`
- **Example**: `"1.4.0"`

#### `suggest.positional`
- **Type**: `boolean | null`
- **Description**: Suggest enabling positional audio
- **Values**: `true`, `false`, or `null` (no suggestion)
- **Example**: `true`

#### `suggest.pushToTalk`
- **Type**: `boolean | null`
- **Description**: Suggest using push-to-talk instead of voice activation
- **Values**: `true`, `false`, or `null` (no suggestion)
- **Example**: `true`

**Example Configuration:**
```json
"suggest": {
  "version": "1.4.0",
  "positional": true,
  "pushToTalk": false
}
```

## Server Registration & Discovery

### `registerPassword` (optional)
- **Type**: `string`
- **Description**: Password for registering to public server list
- **Example**: `"registration-password"`

### `registerHostname` (optional)
- **Type**: `string`
- **Description**: Hostname for server registration
- **Example**: `"mumble.example.com"`

### `registerLocation` (optional)
- **Type**: `string`
- **Description**: Geographic location of the server
- **Example**: `"New York, USA"`

### `registerUrl` (optional)
- **Type**: `string`
- **Description**: Website URL for the server
- **Example**: `"https://example.com"`

### `bonjour` (optional)
- **Type**: `boolean`
- **Description**: Enable Bonjour/Zeroconf for local network discovery
- **Default**: `false`
- **Example**: `true`

## Listener Features

### `listenersPerChannel` (optional)
- **Type**: `number`
- **Description**: Maximum number of listeners per channel (Listen Channel feature)
- **Default**: `0` (unlimited)
- **Example**: `50`

### `listenersPerUser` (optional)
- **Type**: `number`
- **Description**: Maximum number of listener proxies per user
- **Default**: `0` (unlimited)
- **Example**: `10`

### `broadcastListenerVolumeAdjustments` (optional)
- **Type**: `boolean`
- **Description**: Broadcast listener volume adjustments to other clients
- **Default**: `false`
- **Example**: `true`

## Advanced Features

### `allowRecording` (optional)
- **Type**: `boolean`
- **Description**: Allow clients to record audio
- **Default**: `true`
- **Example**: `false`
- **Privacy Note**: Set to `false` for privacy-sensitive environments

### `sendVersion` (optional)
- **Type**: `boolean`
- **Description**: Send server version information to clients
- **Default**: `true`
- **Example**: `false`

### `allowPing` (optional)
- **Type**: `boolean`
- **Description**: Allow clients to ping the server
- **Default**: `true`
- **Example**: `false`

### `hideCertHashes` (optional)
- **Type**: `boolean`
- **Description**: Obfuscate certificate hashes by returning user ID hash instead of real certificate hash
- **Default**: `false`
- **Example**: `true`
- **Privacy Note**: When enabled, UserStats responses will contain a SHA1 hash of the user ID instead of the actual certificate hash, providing additional privacy protection

## TLS Configuration

### `tls` (required)
- **Type**: `object`
- **Description**: TLS/SSL configuration for secure communication

#### `tls.cert`
- **Type**: `string`
- **Description**: Path to TLS certificate file
- **Example**: `"./certs/hub-cert.pem"`

#### `tls.key`
- **Type**: `string`
- **Description**: Path to TLS private key file
- **Example**: `"./certs/hub-key.pem"`

#### `tls.ca`
- **Type**: `string`
- **Description**: Path to Certificate Authority certificate
- **Example**: `"./certs/ca.pem"`

#### `tls.requireClientCert`
- **Type**: `boolean`
- **Description**: Require clients to provide a certificate
- **Default**: `false`
- **Example**: `true`

#### `tls.rejectUnauthorized`
- **Type**: `boolean`
- **Description**: Reject connections with invalid certificates
- **Default**: `false`
- **Example**: `true`

## Registry Configuration

### `registry` (required)
- **Type**: `object`
- **Description**: Configuration for Edge server registry

#### `registry.heartbeatInterval`
- **Type**: `number`
- **Description**: Interval between heartbeats in seconds
- **Example**: `30`

#### `registry.timeout`
- **Type**: `number`
- **Description**: Timeout for considering an Edge server dead
- **Example**: `90`

#### `registry.maxEdges`
- **Type**: `number`
- **Description**: Maximum number of Edge servers
- **Example**: `100`

## Database Configuration

### `database` (required)
- **Type**: `object`
- **Description**: Database configuration for persistent storage

#### `database.path`
- **Type**: `string`
- **Description**: Path to SQLite database file
- **Example**: `"./data/hub.db"`

#### `database.backupDir`
- **Type**: `string`
- **Description**: Directory for database backups
- **Example**: `"./data/backups"`

#### `database.backupInterval`
- **Type**: `number`
- **Description**: Interval between automatic backups in seconds
- **Example**: `86400` (daily)

#### `database.walMode` (optional)
- **Type**: `boolean`
- **Description**: Enable SQLite Write-Ahead Logging for better performance
- **Default**: `false`
- **Example**: `true`
- **Performance Note**: WAL mode can improve write performance

## Blob Storage Configuration

### `blobStore` (required)
- **Type**: `object`
- **Description**: Configuration for blob storage (user avatars, etc.)

#### `blobStore.enabled`
- **Type**: `boolean`
- **Description**: Enable blob storage
- **Example**: `true`

#### `blobStore.path`
- **Type**: `string`
- **Description**: Directory for blob storage
- **Example**: `"./data/blobs"`
- **Note**: Required when `enabled` is `true`

## Web API Configuration

### `webApi` (required)
- **Type**: `object`
- **Description**: Configuration for Web API

#### `webApi.enabled`
- **Type**: `boolean`
- **Description**: Enable Web API
- **Example**: `false`

#### `webApi.port`
- **Type**: `number`
- **Description**: Port for Web API server
- **Example**: `8080`

#### `webApi.cors`
- **Type**: `boolean`
- **Description**: Enable CORS for Web API
- **Example**: `true`

## Logging Configuration

### `logLevel` (required)
- **Type**: `string`
- **Description**: Logging level
- **Values**: `"debug"`, `"info"`, `"warn"`, `"error"`
- **Default**: `"info"`
- **Example**: `"debug"`

### `logFile` (optional)
- **Type**: `string`
- **Description**: Path to log file
- **Example**: `"./logs/hub.log"`

### `logDays` (optional)
- **Type**: `number`
- **Description**: Number of days to retain database logs
- **Default**: `31`
- **Example**: `90`

## Complete Example Configuration

```json
{
  "serverId": 0,
  "name": "MuNode Hub Server",
  "registerName": "MuNode Server",
  "host": "0.0.0.0",
  "port": 65000,
  "timeout": 30,
  "serverPassword": "my-secure-password",
  "maxUsers": 1000,
  "channelNestingLimit": 10,
  "channelCountLimit": 1000,
  "bandwidth": 558000,
  "textMessageLength": 5000,
  "imageMessageLength": 131072,
  "messageLimit": 1,
  "messageBurst": 5,
  "pluginMessageLimit": 4,
  "pluginMessageBurst": 15,
  "kdfIterations": -1,
  "allowHTML": true,
  "usernameRegex": "[ -=\\w\\[\\]\\{\\}\\(\\)\\@\\|\\.]+",
  "channelNameRegex": "[ -=\\w\\#\\[\\]\\{\\}\\(\\)\\@\\|]+",
  "defaultChannel": 0,
  "rememberChannel": true,
  "rememberChannelDuration": 0,
  "welcomeText": "Welcome to our Mumble server!",
  "allowRecording": true,
  "sendVersion": true,
  "allowPing": true,
  "logDays": 31,
  "autoBan": {
    "attempts": 10,
    "timeframe": 120,
    "duration": 300,
    "banSuccessfulConnections": true
  },
  "suggest": {
    "version": "1.4.0",
    "positional": true,
    "pushToTalk": null
  },
  "tls": {
    "cert": "./certs/hub-cert.pem",
    "key": "./certs/hub-key.pem",
    "ca": "./certs/ca.pem",
    "requireClientCert": true,
    "rejectUnauthorized": false
  },
  "registry": {
    "heartbeatInterval": 30,
    "timeout": 90,
    "maxEdges": 100
  },
  "database": {
    "path": "./data/hub.db",
    "backupDir": "./data/backups",
    "backupInterval": 86400,
    "walMode": false
  },
  "blobStore": {
    "enabled": true,
    "path": "./data/blobs"
  },
  "webApi": {
    "enabled": false,
    "port": 8080,
    "cors": true
  },
  "logLevel": "info",
  "logFile": "./logs/hub.log"
}
```

## Validation

The Hub server automatically validates all configuration on startup. If validation fails, the server will not start and will log detailed error messages.

Validation includes:
- Type checking
- Range validation (e.g., ports between 1-65535)
- Required fields presence
- Regular expression syntax
- Logical consistency (e.g., positive timeouts)

Security warnings are logged for potentially unsafe configurations (e.g., no server password, HTML enabled).

## Migration from Older Versions

All new configuration options are optional and have sensible defaults. Existing configuration files will continue to work without modification.

To take advantage of new features, simply add the desired configuration options to your existing config file.

## See Also

- [HUB_CONFIG_COMPARISON.md](./HUB_CONFIG_COMPARISON.md) - Comparison with Murmur configuration
- [config/hub.example.json](../config/hub.example.json) - Example configuration file
