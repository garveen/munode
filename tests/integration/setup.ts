/**
 * 集成测试环境设置
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';

export interface TestEnvironment {
  hubProcess?: ChildProcess;
  edgeProcess?: ChildProcess;
  cleanup: () => Promise<void>;
}

/**
 * 启动 Hub 服务器用于测试
 */
export async function startHubServer(configPath?: string): Promise<ChildProcess> {
  const hubPath = join(__dirname, '../../packages/hub-server/dist/index.js');
  const config = configPath || join(__dirname, '../../config/hub.json');

  const hubProcess = spawn('node', [hubPath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CONFIG_PATH: config,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hub server startup timeout'));
    }, 10000);

    hubProcess.stdout?.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message.includes('Hub server started') || message.includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    hubProcess.stderr?.on('data', (data: Buffer) => {
      console.error('Hub stderr:', data.toString());
    });

    hubProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return hubProcess;
}

/**
 * 启动 Edge 服务器用于测试
 */
export async function startEdgeServer(configPath?: string): Promise<ChildProcess> {
  const edgePath = join(__dirname, '../../packages/edge-server/dist/index.js');
  const config = configPath || join(__dirname, '../../config/edge.example.json');

  const edgeProcess = spawn('node', [edgePath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CONFIG_PATH: config,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等待服务器启动
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Edge server startup timeout'));
    }, 10000);

    edgeProcess.stdout?.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message.includes('Edge server started') || message.includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    edgeProcess.stderr?.on('data', (data: Buffer) => {
      console.error('Edge stderr:', data.toString());
    });

    edgeProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return edgeProcess;
}

/**
 * 设置完整的测试环境 (Hub + Edge)
 */
export async function setupTestEnvironment(): Promise<TestEnvironment> {
  const hubProcess = await startHubServer();
  const edgeProcess = await startEdgeServer();

  const cleanup = async () => {
    if (edgeProcess) {
      edgeProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        edgeProcess.on('exit', () => resolve());
        setTimeout(() => {
          edgeProcess.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }

    if (hubProcess) {
      hubProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        hubProcess.on('exit', () => resolve());
        setTimeout(() => {
          hubProcess.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }
  };

  return { hubProcess, edgeProcess, cleanup };
}

/**
 * 等待指定时间
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
