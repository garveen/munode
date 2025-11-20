# MuNode - Mumble Server Node.js Implementation

基于 Node.js 22 和 TypeScript 的分布式 Mumble 服务器实现。

## 特性

- ✅ 完全兼容 Mumble 1.3.x 和 1.4.x 客户端
- ✅ 分布式架构 (Hub-Edge)
- ✅ 第三方 Web API 认证
- ✅ 多种服务器间连接方式 (SMUX/gRPC/KCP)
- ✅ SQLite 持久化存储
- ✅ OCB2-AES128 语音加密
- ✅ 智能语音路由
- ✅ UDP 稳定性检测
- ✅ Context Actions 右键菜单系统
- ✅ 多维度封禁系统

## 快速开始

### 环境要求

- Node.js >= 22.0.0
- pnpm >= 8.0.0

### 安装依赖

```bash
pnpm install
```

### 生成 Protobuf 代码

```bash
pnpm generate:proto
```

### 构建

```bash
pnpm build
```

### 运行

#### 独立模式（单服务器）

```bash
# 生成证书
pnpm generate:cert

# 启动 Edge Server
pnpm start:edge --config config/edge.json
```

#### 集群模式（分布式）

```bash
# 启动 Hub Server
pnpm start:hub --config config/hub.json

# 启动 Edge Servers
pnpm start:edge --config config/edge1.json
pnpm start:edge --config config/edge2.json
```

## 项目结构

```
node/
├── packages/
│   ├── common/          # 共享代码
│   ├── protocol/        # Mumble 协议实现
│   ├── hub-server/      # 中心服务器
│   ├── edge-server/     # 边缘服务器
│   └── cli/             # 命令行工具
├── config/              # 配置文件
├── docs/                # 文档（在上层 docs/ 目录）
└── scripts/             # 构建脚本
```

## 文档

详细文档请查看 `docs/` 目录：

- [项目概述](../docs/01-项目概述.md)
- [协议实现](../docs/02-协议实现.md)
- [认证系统](../docs/03-认证系统.md)
- [中心服务器](../docs/04-中心服务器.md)
- [边缘服务器](../docs/05-边缘服务器.md)
- [语音路由](../docs/06-语音路由.md)
- [部署指南](../docs/07-部署指南.md)

## 开发

```bash
# 开发模式（热重载）
pnpm dev

# 只启动 Hub Server
pnpm dev:hub

# 只启动 Edge Server
pnpm dev:edge

# 运行测试
pnpm test

# 代码检查
pnpm lint
pnpm lint:fix

# 类型检查
pnpm type-check

# 格式化代码
pnpm format
```

## 配置

配置示例文件位于 `config/` 目录：

- `hub.example.json` - Hub Server 配置
- `edge.example.json` - Edge Server 配置

复制示例文件并修改：

```bash
cp config/hub.example.json config/hub.json
cp config/edge.example.json config/edge.json
```

## 许可证

MIT License

## 致谢

基于以下项目：
- [Mumble Protocol](https://github.com/mumble-voip/mumble)
- [Grumble](https://github.com/mumble-voip/grumble)
- [ShitSpeak](https://github.com/wfjsw/shitspeak.go)
