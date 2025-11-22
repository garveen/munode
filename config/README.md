# MuNode Configuration Guide

This directory contains example configuration files for MuNode servers and clients.

## ⚠️ Breaking Changes in This Version

**HTTP API Authentication Field Mapping Removed**: The `requestFields` configuration option has been removed. If you're using HTTP API authentication, your API must now accept standard field names:

- `username`, `password`, `tokens`
- `session_id`, `server_id`  
- `ip_address`, `ip_version`
- `release`, `version`, `os`, `os_version`
- `certificate_hash`

**Migration Options:**
1. Update your authentication API to accept standard field names, OR
2. Switch to the new callback-based authentication (recommended)

---

## Configuration Files

- `hub.example.js` - Hub Server configuration example
- `edge.example.js` - Edge Server configuration example  
- `client.example.js` - Headless Client configuration example

## File Formats

MuNode supports both **JavaScript (ES modules)** and **JSON** configuration files:

### JavaScript Configurations (Recommended)

JavaScript configs provide:
- **Type checking** via JSDoc annotations
- **Dynamic configuration** with functions and logic
- **Callback-based authentication** for custom auth logic
- **IDE autocomplete** support

Example:
```javascript
/**
 * @type {import('../packages/hub-server/src/types.js').HubConfig}
 */
export default {
  server_id: 0,
  name: 'My MuNode Server',
  host: '0.0.0.0',
  port: 65000,
  // ... other settings
};
```

### JSON Configurations (Legacy)

JSON configs are still supported for backward compatibility:

```json
{
  "server_id": 0,
  "name": "My MuNode Server",
  "host": "0.0.0.0",
  "port": 65000
}
```

## Authentication Configuration

### Callback-Based Authentication (Recommended)

The new callback-based approach provides maximum flexibility:

```javascript
export default {
  // ... other config
  auth: {
    // Custom authentication callback
    callback: async (request) => {
      const { 
        username, 
        password, 
        tokens,
        session_id, 
        server_id,
        ip_address,
        ip_version,
        release,
        version,
        os,
        os_version,
        certificate_hash 
      } = request;
      
      // Your custom authentication logic
      // Example: Check against database
      const user = await database.findUser(username);
      
      if (user && await user.verifyPassword(password)) {
        return {
          success: true,
          user_id: user.id,
          username: user.username,
          displayName: user.displayName,
          groups: user.groups, // e.g., ['user', 'admin']
        };
      }
      
      return {
        success: false,
        reason: 'Invalid credentials',
        rejectType: 2, // WrongUserPW
      };
    },
    
    // Cache settings
    cacheTTL: 300000, // 5 minutes in milliseconds
    allowCacheFallback: false,
  },
};
```

### HTTP API Authentication (Legacy)

The HTTP API approach is still supported for backward compatibility:

```javascript
export default {
  // ... other config
  auth: {
    // HTTP API settings
    apiUrl: 'https://auth.example.com/api/authenticate',
    apiKey: 'your-secret-key',
    timeout: 5000,
    contentType: 'application/json', // or 'application/x-www-form-urlencoded'
    
    // Request headers
    headers: {
      authHeaderName: 'Authorization',
      authHeaderFormat: 'Bearer {apiKey}',
    },
    
    // Response field mapping
    responseFields: {
      successField: 'success',
      userIdField: 'user_id',
      usernameField: 'username',
      displayNameField: 'displayName',
      groupsField: 'groups',
      reasonField: 'reason',
    },
    
    // Cache settings
    cacheTTL: 300000,
    allowCacheFallback: true,
  },
};
```

## Getting Started

1. Copy an example config to create your own:
   ```bash
   cp config/hub.example.js config/hub.js
   ```

2. Edit the configuration file to match your needs:
   ```bash
   nano config/hub.js
   ```

3. Start the server with your config:
   ```bash
   pnpm --filter hub-server start --config ./config/hub.js
   ```

## Configuration References

### Hub Server Configuration

See [`hub.example.js`](./hub.example.js) for a complete example with comments explaining each option.

Key sections:
- Server identification (server_id, name)
- Network settings (host, port, TLS)
- Database and storage
- Edge registry settings
- Authentication
- User and channel limits
- Security settings

### Edge Server Configuration

See [`edge.example.js`](./edge.example.js) for a complete example.

Key sections:
- Server identification (server_id, name, region)
- Network settings (host, port, TLS)
- Hub connection settings
- Authentication
- UDP settings
- Feature flags

### Client Configuration

See [`client.example.js`](./client.example.js) for a complete example.

Key sections:
- Mumble server connection
- Authentication
- Audio encoder/decoder settings
- HTTP API settings
- WebSocket settings
- Webhooks

## Environment-Specific Configs

You can create environment-specific configs:

```
config/
  ├── hub.example.js       # Example template
  ├── hub.development.js   # Development settings
  ├── hub.production.js    # Production settings
  └── hub.test.js          # Test settings
```

Then load the appropriate config:

```bash
# Development
pnpm --filter hub-server start --config ./config/hub.development.js

# Production
pnpm --filter hub-server start --config ./config/hub.production.js
```

## Security Best Practices

1. **Never commit production configs** with secrets to version control
2. **Use environment variables** for sensitive data
3. **Enable TLS/SSL** in production
4. **Set strong authentication** requirements
5. **Limit access** with proper ACLs
6. **Regular backups** of database and blob storage

## Troubleshooting

### Config Loading Errors

If you see errors loading your config:

1. **Check syntax**: Ensure valid JavaScript/JSON syntax
2. **Check file path**: Use absolute or relative paths correctly
3. **Check module type**: Use `export default` for ES modules
4. **Check types**: Verify config matches expected type schema

### Authentication Issues

If authentication fails:

1. **Check callback logic**: Ensure async function returns proper format
2. **Check API connectivity**: Verify API URL is reachable
3. **Check cache settings**: Review TTL and fallback settings
4. **Check logs**: Enable debug logging for more details

## More Information

- [MuNode Documentation](../docs/)
- [Hub Server README](../packages/hub-server/README.md)
- [Edge Server README](../packages/edge-server/README.md)
- [Client README](../packages/client/README.md)
