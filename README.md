# MuNode - Distributed Mumble Server

A modern, distributed Mumble server implementation built with Node.js 22 and TypeScript, featuring Hub-Edge architecture for horizontal scalability.

## Features

### Core Features
- ✅ **Full Protocol Support** - Compatible with Mumble 1.3.x and 1.4.x clients
- ✅ **Distributed Architecture** - Hub-Edge design for horizontal scaling
- ✅ **External Authentication** - Third-party Web API integration
- ✅ **WebSocket + Protobuf RPC** - Type-safe server-to-server communication
- ✅ **Persistent Storage** - SQLite with async operations
- ✅ **Voice Encryption** - OCB2-AES128 encryption for audio streams

### Advanced Features
- ✅ **Intelligent Voice Routing** - Optimized audio forwarding with VoiceTarget support
- ✅ **UDP Stability Detection** - Automatic fallback to TCP when UDP is unstable
- ✅ **Context Actions System** - Right-click menu integration
- ✅ **Multi-dimensional Ban System** - IP, certificate, and username-based bans
- ✅ **ACL Inheritance** - Hierarchical permission system with group support
- ✅ **Listen Channel Support** - Monitor channels without joining
- ✅ **Plugin Data Transmission** - Support for positional audio and game plugins
- ✅ **Cross-Edge Voice Relay** - Seamless voice transmission across Edge servers

### Recent Improvements
- ✅ **Pre-connect User State** - Preserve client settings during authentication
- ✅ **Dynamic Permission Refresh** - ACL changes take effect immediately
- ✅ **Type-safe RPC System** - Protobuf-based type-safe communication
- ✅ **Enhanced Testing** - Comprehensive integration test suite (27 test suites, 100+ test cases)

## Quick Start

### Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 8.0.0

### Installation

```bash
# Clone the repository
git clone https://github.com/garveen/munode.git
cd munode

# Install dependencies
pnpm install

# Generate Protocol Buffers code
pnpm generate:proto

# Build all packages
pnpm build
```

### Configuration

Copy example configuration files:

```bash
cp config/hub.example.json config/hub.json
cp config/edge.example.json config/edge.json
```

Edit the configuration files to match your environment. See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed configuration options.

### Running

#### Development Mode

```bash
# Start Hub Server
pnpm dev:hub

# Start Edge Server (in another terminal)
pnpm dev:edge
```

#### Production Mode

```bash
# Build first
pnpm build

# Start Hub Server
pnpm start:hub --config config/hub.json

# Start Edge Server
pnpm start:edge --config config/edge.json
```

## Architecture

### Hub-Edge Design

```
                    ┌─────────────┐
                    │  Hub Server │
                    │  (Central)  │
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
       ┌────▼────┐    ┌────▼────┐   ┌────▼────┐
       │ Edge #1 │    │ Edge #2 │   │ Edge #3 │
       └────┬────┘    └────┬────┘   └────┬────┘
            │              │              │
         Clients        Clients        Clients
```

### Components

#### Hub Server (`packages/hub-server`)
- Central management node
- User authentication and authorization
- Channel and ACL management
- Edge server registry
- Data persistence (SQLite)
- Cross-edge voice routing coordination

#### Edge Server (`packages/edge-server`)
- Client connection handling
- Voice packet processing
- Local voice routing
- UDP stability detection
- Authentication caching
- Ban management

#### Common (`packages/common`)
- Shared utilities and types
- Configuration management
- Logging system
- Heartbeat mechanism

#### Protocol (`packages/protocol`)
- Protocol Buffers definitions
- Type-safe RPC communication
- Mumble protocol implementation
- OCB2-AES128 encryption

#### CLI (`packages/cli`)
- Certificate generation
- Server management tools

#### Client (`packages/client`)
- Mumble client implementation (for testing)

## Project Structure

```
munode/
├── packages/
│   ├── common/          # Shared utilities, types, logging
│   ├── protocol/        # Mumble protocol, encryption, RPC
│   ├── hub-server/      # Central management server
│   ├── edge-server/     # Edge server for client connections
│   ├── client/          # Mumble client implementation (for testing)
│   └── cli/             # Command-line tools
├── config/              # Configuration files
│   ├── hub.example.js
│   ├── edge.example.js
│   └── client.example.js
├── tests/               # Test suites
│   ├── integration/     # Integration tests (27 test suites)
│   ├── unit/            # Unit tests
│   └── utils/           # Test utilities
├── docs/                # Documentation
├── scripts/             # Build and utility scripts
└── .github/             # GitHub configurations
    └── copilot-instructions.md  # AI coding guidelines
```

## Development

### Available Commands

```bash
# Development
pnpm dev              # Start all servers in dev mode
pnpm dev:hub          # Start only Hub server
pnpm dev:edge         # Start only Edge server

# Building
pnpm build            # Build all packages
pnpm clean            # Clean build artifacts

# Testing
pnpm test                      # Run unit tests
pnpm test:watch                # Run unit tests in watch mode
pnpm test:integration          # Run integration tests
pnpm test:integration:watch    # Run integration tests in watch mode
pnpm test:integration:ui       # Run integration tests with UI

# Code Quality
pnpm lint             # Lint all packages
pnpm lint:fix         # Fix linting issues
pnpm type-check       # TypeScript type checking
pnpm format           # Format code with Prettier

# Protocol Buffers
pnpm generate:proto   # Generate TS code from .proto files
```

### Integration Tests

The project includes comprehensive integration tests covering:

- **Authentication** (10+ tests) - Password, certificate, token auth
- **ACL System** (15+ tests) - Permissions, inheritance, groups, suppress
- **Channel Management** (11+ tests) - Create, move, link, delete
- **Voice Transmission** (15+ tests) - Normal, whisper, VoiceTarget, loopback
- **Voice Routing** (10+ tests) - Cross-edge routing, quality detection
- **Hub-Edge Communication** (8+ tests) - Registration, sync, routing
- **Ban System** (6+ tests) - IP, certificate, username bans
- **Plugin System** (9+ tests) - Plugin data transmission
- **UDP Quality** (5+ tests) - Connection quality simulation
- **TCP Voice** (8+ tests) - TCP voice fallback
- **User Visibility** (4+ tests) - Cross-edge user state sync
- **Pre-connect State** (3+ tests) - Client state preservation

Total: **27 test suites, 100+ integration test cases**

Run tests with:
```bash
# Run all integration tests
pnpm test:integration

# Run specific test suite
pnpm test:integration tests/integration/suites/voice.test.ts

# Run tests in watch mode
pnpm test:integration:watch

# Run tests with UI
pnpm test:integration:ui
```

## Configuration

### Hub Server Configuration

Key configuration options in `config/hub.js`:

- **Network** - Host, port, TLS settings
- **Database** - SQLite path, backup settings  
- **Control Channel** - WebSocket port for Edge connections
- **Blob Store** - User avatars and channel descriptions
- **Web API** - Optional REST API (for management)
- **Voice UDP** - Shared secret for UDP handshake

### Edge Server Configuration

Key configuration options in `config/edge.js`:

- **Network** - Host, port, region, capacity
- **Hub Connection** - Hub server address, control port, TLS
- **Authentication** - External API configuration
- **Server Settings** - Welcome text, limits, permissions
- **UDP** - Stability detection settings
- **Ban System** - Ban database configuration
- **Voice Encryption** - OCB2-AES128 settings

See configuration examples in the `config/` directory.

## Deployment

For production deployment:

1. **Build the project**:
   ```bash
   pnpm install
   pnpm generate:proto
   pnpm build
   ```

2. **Configure servers**:
   ```bash
   cp config/hub.example.js config/hub.js
   cp config/edge.example.js config/edge.js
   # Edit configuration files as needed
   ```

3. **Generate certificates**:
   ```bash
   pnpm generate:cert
   ```

4. **Start services**:
   ```bash
   # Using PM2 (recommended)
   pm2 start pnpm --name munode-hub -- start:hub
   pm2 start pnpm --name munode-edge -- start:edge
   
   # Or using systemd
   # Create systemd service files for hub and edge
   ```

### System Requirements

- **CPU**: 2+ cores recommended
- **Memory**: 2GB+ RAM (Hub), 4GB+ RAM per Edge (1000 users)
- **Network**: Low latency connection between Hub and Edge servers
- **Storage**: SSD recommended for database

### Performance Tuning

- Enable UDP for better voice quality
- Use dedicated servers for Hub and Edge in production
- Configure appropriate `maxClients` per Edge based on your hardware
- Monitor memory usage and adjust Node.js heap size if needed

## Documentation

### Core Documentation
- [Copilot Instructions](.github/copilot-instructions.md) - Coding guidelines and architecture overview
- [Implementation Comparison](./IMPLEMENTATION_COMPARISON.md) - Node vs Go implementation

### Technical Documentation (Chinese)
Located in `docs/` directory:
- [10-数据同步架构.md](docs/10-数据同步架构.md)
- [Edge-Hub-WebSocket-Protobuf重构方案.md](docs/Edge-Hub-WebSocket-Protobuf重构方案.md)
- [Edge间语音中转路由设计.md](docs/Edge间语音中转路由设计.md)
- [Edge语音路由实现总结.md](docs/Edge语音路由实现总结.md)
- [RPC路由降级架构设计.md](docs/RPC路由降级架构设计.md)
- [通信信道技术选型.md](docs/通信信道技术选型.md)
- [频道树传输流程.md](docs/频道树传输流程.md)
- [语音传输逻辑.md](docs/语音传输逻辑.md)

### API Documentation
Each package contains detailed README files:
- `packages/common/README.md` - Shared utilities
- `packages/protocol/README.md` - Protocol implementation
- `packages/hub-server/README.md` - Hub server API
- `packages/edge-server/README.md` - Edge server API
- `packages/client/README.md` - Client API

## Performance

### Typical Performance Metrics

- **Latency** (same Edge): ~5-10ms
- **Latency** (cross-Edge): ~20-50ms
- **Memory** per client: ~5-10 MB
- **CPU** usage: Low to moderate (depends on codec)

### Scalability

- **Hub Server**: Supports up to 100 Edge servers
- **Edge Server**: 1000 concurrent users per server (recommended)
- **Total Capacity**: 100,000+ users (with 100 Edge servers)

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript strict mode - no `any`, `unknown`, or loose types
- Prefer `interface` over `type` for object types
- Use ESModule syntax (not CommonJS)
- Write integration tests for new features
- Follow existing code style and naming conventions
- Update documentation for significant changes

See [.github/copilot-instructions.md](./.github/copilot-instructions.md) for detailed coding guidelines.

### Running Tests

```bash
# Run all tests
pnpm test

# Run unit tests
pnpm test:unit

# Run integration tests
pnpm test:integration

# Run tests in watch mode
pnpm test:integration:watch
```

## License

MIT License - see [LICENSE](../LICENSE) for details

## Acknowledgments

This project is inspired by and based on:

- [Mumble Protocol](https://github.com/mumble-voip/mumble) - The original Mumble VoIP protocol
- [Grumble](https://github.com/mumble-voip/grumble) - Go implementation of Mumble server
- [Hall (ShitSpeak)](https://github.com/wfjsw/hall) - Go-based Mumble server with enhancements

## Support

- **Issues**: [GitHub Issues](https://github.com/garveen/munode/issues)
- **Discussions**: [GitHub Discussions](https://github.com/garveen/munode/discussions)

## Status

**Current Version**: 0.1.0 (Beta)

**Production Ready**: ⚠️ Beta stage - suitable for testing and small-to-medium deployments. Thoroughly test in your environment before large-scale production use.

**Core Features Status**:
- ✅ Full Mumble protocol support (1.3.x and 1.4.x)
- ✅ Hub-Edge distributed architecture
- ✅ Voice transmission (UDP + TCP fallback)
- ✅ Channel and user management
- ✅ ACL and permission system
- ✅ Plugin data transmission
- ✅ Cross-edge voice routing
- ✅ External authentication integration

**Known Limitations**:
- ⚠️ Blob storage system (avatars, comments) partially implemented
- ⚠️ Some statistics counters return placeholder values  
- ⚠️ Limited production deployment experience

**Test Coverage**:
- ✅ 27 integration test suites
- ✅ 100+ test cases covering core functionality
- ✅ All critical features tested and verified
