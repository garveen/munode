# MuNode 项目初始化完成

## ✅ 已完成的工作

### 1. 项目结构创建
- ✅ 使用 pnpm workspace 创建 monorepo 结构
- ✅ 创建了 5 个子包：
  - `@munode/common` - 共享代码和工具
  - `@munode/protocol` - Mumble 协议实现
  - `@munode/hub-server` - 中心服务器
  - `@munode/edge-server` - 边缘服务器
  - `@munode/cli` - 命令行工具

### 2. 依赖安装完成
- ✅ TypeScript 5.4.5
- ✅ Node.js 类型定义 (@types/node)
- ✅ Winston 日志库
- ✅ Axios HTTP 客户端
- ✅ **sqlite + sqlite3 异步 SQLite 库**（替代 better-sqlite3）
- ✅ LRU Cache
- ✅ Commander.js (CLI)
- ✅ Protobuf 工具链 (ts-proto)
- ✅ ESLint + Prettier
- ✅ Vitest 测试框架
- ✅ tsx (开发热重载)

### 3. 配置文件创建
- ✅ `tsconfig.base.json` - TypeScript 基础配置
- ✅ `tsconfig.json` - 项目引用配置
- ✅ `.eslintrc.cjs` - ESLint 规则
- ✅ `.prettierrc` - 代码格式化
- ✅ `pnpm-workspace.yaml` - Workspace 配置
- ✅ `.gitignore` - Git 忽略规则
- ✅ `.nvmrc` - Node 版本锁定 (22)

### 4. 示例配置文件
- ✅ `config/hub.example.json` - Hub Server 配置示例
- ✅ `config/edge.example.json` - Edge Server 配置示例

### 5. 基础代码框架
- ✅ Common 包基础类型定义
- ✅ Logger 工具函数
- ✅ 配置加载器
- ✅ Buffer 和 Varint 工具函数

## 📋 下一步需要做的工作

### 阶段 1: 协议实现 (优先级最高)
1. **复制 Mumble.proto 文件**
   - 从 Go 项目复制 `mumbleproto/Mumble.proto` 到 `packages/protocol/proto/`
   - 运行 `pnpm generate:proto` 生成 TypeScript 代码

2. **实现 OCB2-AES128 加密**
   - 创建 `packages/protocol/src/crypto/ocb2.ts`
   - 实现加密/解密方法
   - 实现密钥生成

3. **实现包解析器**
   - TCP 包解析器 (MessageType + Length + Payload)
   - UDP 包解析器 (Header + Encrypted Data)
   - Varint 编解码

### 阶段 2: 服务器间连接库安装
**需要人工选择安装哪些库：**

```bash
# 选项 1: SMUX (推荐，轻量级)
cd /root/shitspeak.go/node
pnpm add -w smux-js  # 或其他 SMUX 实现

# 选项 2: gRPC (标准化)
pnpm add -w @grpc/grpc-js @grpc/proto-loader

# 选项 3: KCP (低延迟)
pnpm add -w node-kcp
```

**建议：** 先实现 SMUX，因为它最轻量且适合实时通信。

### 阶段 3: Hub Server 实现
1. **数据库初始化**
   - 创建 SQLite schema (edges, sessions, voice_targets 等表)
   - 实现异步数据库封装（使用 sqlite + sqlite3）
   - 实现迁移系统

2. **服务注册与发现**
   - EdgeRegistry 实现
   - 心跳监控
   - 证书交换服务

3. **TLS Server**
   - 监听 Edge 连接
   - 消息路由
   - 广播机制

### 阶段 4: Edge Server 实现
1. **客户端连接处理**
   - TLS Socket 监听
   - 包解析
   - 消息分发

2. **第三方认证**
   - API 客户端实现
   - 用户缓存 (users.json)
   - 会话管理

3. **频道管理**
   - 频道树
   - ACL 权限检查
   - 用户移动

4. **语音路由**
   - UDP 监听
   - 本地路由
   - 跨服务器路由

## 🚨 需要人工介入的决策

### 1. 服务器间连接方式选择
请决定首先实现哪种连接方式：
- **SMUX** (推荐) - 轻量、低延迟
- **gRPC** - 标准化、生态成熟
- **KCP** - 极低延迟、弱网优化

### 2. Protobuf 文件准备
需要从 Go 项目复制 `Mumble.proto` 文件到 `packages/protocol/proto/` 目录。

位置：`/root/shitspeak.go/mumbleproto/Mumble.proto`

### 3. 加密库选择
OCB2-AES128 加密需要：
- 使用 Node.js 内置 `crypto` 模块
- 或安装专门的 OCB 加密库

建议先用 `crypto` 模块实现，参考 Go 代码逻辑。

## 📝 项目命名说明

已将所有 `shitspeak` 替换为 `munode`：
- 包名：`@munode/*`
- 项目名：`munode`
- 配置中的服务器名：`MuNode Hub Server` / `MuNode Edge Server`
- 日志服务名：`munode`

## 🛠️ 可用命令

```bash
# 安装依赖（已完成）
pnpm install

# 开发模式（热重载）
pnpm dev          # 所有包
pnpm dev:hub      # 仅 Hub Server
pnpm dev:edge     # 仅 Edge Server

# 构建
pnpm build

# 生成 Protobuf（需先复制 .proto 文件）
pnpm generate:proto

# 代码检查
pnpm lint
pnpm lint:fix

# 格式化
pnpm format

# 测试
pnpm test
```

## 📦 已安装的关键依赖

### 运行时依赖
- `winston` - 日志
- `axios` - HTTP 客户端
- `sqlite` + `sqlite3` - **异步 SQLite 数据库**
- `lru-cache` - LRU 缓存
- `commander` - CLI
- `protobufjs` + `ts-proto` - Protobuf

### 开发依赖
- `typescript` - TypeScript 编译器
- `tsx` - TypeScript 执行器
- `eslint` - 代码检查
- `prettier` - 代码格式化
- `vitest` - 测试框架

## 🎯 立即可以开始的任务

1. **复制 Mumble.proto 文件**
   ```bash
   cp /root/shitspeak.go/mumbleproto/Mumble.proto /root/shitspeak.go/node/packages/protocol/proto/
   ```

2. **生成 TypeScript Protobuf 代码**
   ```bash
   cd /root/shitspeak.go/node
   pnpm generate:proto
   ```

3. **决定并安装服务器间连接库**
   - 推荐：SMUX (需要找到合适的 npm 包)
   - 备选：gRPC (已知可用)

4. **开始实现 OCB2 加密**
   - 参考 Go 代码：`/root/shitspeak.go/cryptstate/`
   - 创建 TypeScript 版本

---

**状态：** ✅ 项目初始化完成，可以开始开发核心功能
**下一步：** 复制 Mumble.proto 并安装服务器间连接库
