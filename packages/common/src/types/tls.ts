import type { TLSConfig } from './config.js';

// TLS 选项
export interface TLSOptions extends TLSConfig {
  passphrase?: string;
  ciphers?: string;
  minVersion?: string;
  maxVersion?: string;
}

// 证书信息
export interface CertificateInfo {
  serverId: number;
  pem: string;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  subject: unknown;
  issuer: unknown;
}

// 证书交换结果
export interface CertificateExchangeResult {
  success: boolean;
  certificates?: Record<number, string>;
  error?: string;
}
