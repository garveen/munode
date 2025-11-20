import { createLogger } from '@munode/common';
import type { CertificateInfo, CertificateExchangeResult } from './types.js';
import type { ServiceRegistry } from './registry.js';

const logger = createLogger({ service: 'hub-cert-exchange' });

/**
 * 证书交换服务
 * 管理 Edge Server 间的证书交换
 */
export class CertificateExchangeService {
  private certificates = new Map<number, CertificateInfo>();

  constructor(_registry: ServiceRegistry) {
    // 暂时不需要 registry，但保留以备将来使用
  }

  /**
   * 注册证书
   */
  async registerCertificate( server_id: number, certificate: string): Promise<void> {
    try {
      const cert = this.parseCertificate(certificate);
      if (!cert) {
        throw new Error('Invalid certificate');
      }

      this.certificates.set(server_id, {
        server_id,
        pem: certificate,
        fingerprint: this.getFingerprint(cert),
        notBefore: cert.validity.notBefore,
        notAfter: cert.validity.notAfter,
        subject: cert.subject,
        issuer: cert.issuer,
      });

      logger.info(`Certificate registered for Edge ${server_id}`);
    } catch (error) {
      logger.error(`Failed to register certificate for Edge ${server_id}:`, error);
      throw error;
    }
  }

  /**
   * 获取证书
   */
  getCertificate( server_id: number): CertificateInfo | undefined {
    return this.certificates.get(server_id);
  }

  /**
   * 获取所有证书
   */
  getAllCertificates(): Map<number, CertificateInfo> {
    return new Map(this.certificates);
  }

  /**
   * 交换两个 Edge 的证书
   */
  async exchangeCertificates(
    serverId1: number,
    serverId2: number
  ): Promise<CertificateExchangeResult> {
    const cert1 = this.certificates.get(serverId1);
    const cert2 = this.certificates.get(serverId2);

    if (!cert1 || !cert2) {
      return {
        success: false,
        error: 'One or both certificates not found',
      };
    }

    return {
      success: true,
      certificates: {
        [serverId1]: cert1.pem,
        [serverId2]: cert2.pem,
      },
    };
  }

  /**
   * 验证证书有效性
   */
  validateCertificate( server_id: number): boolean {
    const cert = this.certificates.get(server_id);
    if (!cert) return false;

    const now = new Date();
    return now >= cert.notBefore && now <= cert.notAfter;
  }

  /**
   * 清理过期证书
   */
  cleanupExpiredCertificates(): void {
    const now = new Date();
    const toRemove: number[] = [];

    for (const [server_id, cert] of this.certificates.entries()) {
      if (now > cert.notAfter) {
        toRemove.push(server_id);
      }
    }

    for (const server_id of toRemove) {
      this.certificates.delete(server_id);
      logger.info(`Removed expired certificate for Edge ${server_id}`);
    }
  }

  /**
   * 解析证书 (使用 node-forge)
   */
  private parseCertificate(pem: string): any {
    try {
      const forge = require('node-forge');
      return forge.pki.certificateFromPem(pem);
    } catch (error) {
      logger.error('Failed to parse certificate:', error);
      return null;
    }
  }

  /**
   * 获取证书指纹
   */
  private getFingerprint(cert: any): string {
    try {
      const forge = require('node-forge');
      const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
      const md = forge.md.sha256.create();
      md.update(der);
      return md.digest().toHex();
    } catch (error) {
      logger.error('Failed to get certificate fingerprint:', error);
      return '';
    }
  }
}
