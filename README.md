# MuNode - Distributed Mumble Server

A modern, distributed Mumble server implementation built with Node.js 22 and TypeScript, featuring Hub-Edge architecture for horizontal scalability.

## Features

### Core Features
- ✅ **Full Protocol Support** - Compatible with Mumble 1.3.x and 1.4.x clients
- ✅ **Distributed Architecture** - Hub-Edge design for horizontal scaling
- ✅ **External Authentication** - Third-party Web API integration
- ✅ **Multiple Transport Options** - SMUX/gRPC/KCP for server-to-server communication
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

### Recent Improvements
- ✅ **Pre-connect User State** - Preserve client settings during authentication
- ✅ **Dynamic Permission Refresh** - ACL changes take effect immediately
- ✅ **Enhanced Testing** - Comprehensive integration test suite (42+ test cases)

## Quick Start

### Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 8.0.0

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd node

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
node/
├── packages/
│   ├── common/          # Shared utilities, types, logging
│   ├── protocol/        # Mumble protocol, encryption, RPC
│   ├── hub-server/      # Central management server
│   ├── edge-server/     # Edge server for client connections
│   ├── client/          # Test client implementation
│   └── cli/             # Command-line tools
├── config/              # Configuration files
│   ├── hub.example.json
│   └── edge.example.json
├── tests/               # Integration tests
│   └── integration/
│       └── suites/
├── docs/                # Documentation (in ../docs/)
└── scripts/             # Build and utility scripts
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

- **Authentication** (10 tests) - Password, certificate, token auth
- **ACL System** (8 tests) - Permissions, inheritance, groups
- **Channel Management** (11 tests) - Create, move, link, delete
- **Voice Transmission** (8 tests) - Normal, whisper, VoiceTarget
- **Hub-Edge Communication** (5 tests) - Registration, sync, routing
- **Moderation** (tests) - Ban system, user management
- **Plugin System** (tests) - Plugin data transmission
- **Listen Channel** (tests) - Monitor channels feature

Total: 42+ integration test cases

Run tests with:
```bash
pnpm test:integration
```

## Configuration

### Hub Server Configuration

Key configuration options in `config/hub.json`:

- **Network** - Host, port, TLS settings
- **Database** - SQLite path, backup settings
- **Registry** - Edge server management
- **Blob Store** - User avatars and channel descriptions
- **Web API** - Optional REST API (for management)

### Edge Server Configuration

Key configuration options in `config/edge.json`:

- **Network** - Host, port, region, capacity
- **Hub Connection** - Hub server address and TLS
- **Authentication** - External API configuration
- **Server Settings** - Welcome text, limits, permissions
- **UDP** - Stability detection settings
- **Ban System** - Ban database configuration

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete configuration reference.

## Deployment

For production deployment instructions, including:
- System requirements
- Installation steps
- Certificate generation
- Process management (PM2, systemd)
- Monitoring and logging
- Performance tuning
- Backup strategies

Please refer to [DEPLOYMENT.md](./DEPLOYMENT.md)

## Documentation

### User Documentation
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment instructions

### Developer Documentation (Chinese)
- [Project Overview](../docs/01-项目概述.md)
- [Protocol Implementation](../docs/02-协议实现.md)
- [Authentication System](../docs/03-认证系统.md)
- [Hub Server](../docs/04-中心服务器.md)
- [Edge Server](../docs/05-边缘服务器.md)
- [Voice Routing](../docs/06-语音路由.md)

### Technical Documentation
- [Integration Tests Guide](tests/integration/INTEGRATION_TESTS.md)
- [Implementation Comparison](./IMPLEMENTATION_COMPARISON.md) - Node vs Go implementation
- [Missing Features](./MISSING_FEATURES.md) - Roadmap and TODO items

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

- Follow TypeScript strict mode
- Write tests for new features
- Follow existing code style
- Update documentation

See [.github/copilot-instructions.md](./.github/copilot-instructions.md) for detailed coding guidelines.

## License

MIT License - see [LICENSE](../LICENSE) for details

## Acknowledgments

This project is based on and inspired by:

- [Mumble Protocol](https://github.com/mumble-voip/mumble) - The original Mumble VoIP protocol
- [Grumble](https://github.com/mumble-voip/grumble) - Go implementation of Mumble server
- [ShitSpeak](https://github.com/wfjsw/shitspeak.go) - Go-based Mumble server with enhancements

## Support

- **Issues**: [GitHub Issues](https://github.com/your-org/munode/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-org/munode/discussions)

## Status

**Current Version**: 0.1.0 (Beta)

**Production Ready**: Suitable for testing and small-to-medium deployments. Large-scale production use should be thoroughly tested in your environment first.

**Known Limitations**:
- Blob storage system (avatars, comments) partially implemented
- Some statistics counters return placeholder values
- UserList management features not fully implemented

See [MISSING_FEATURES.md](./MISSING_FEATURES.md) for detailed status and roadmap.
