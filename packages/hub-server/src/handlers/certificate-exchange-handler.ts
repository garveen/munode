import type { HubHandlerFactory } from '../factory.js';
import type { RPCParams, RPCResult } from '@munode/protocol';

/**
 * Hub 证书交换处理器接口
 */
export interface ICertificateExchangeHandler {
  handleExchangeCertificates(params: RPCParams<'edge.exchangeCertificates'>): Promise<RPCResult<'edge.exchangeCertificates'>>;
}

/**
 * Hub 证书交换处理器 - 处理证书交换相关的操作
 */
export class CertificateExchangeHandler implements ICertificateExchangeHandler {
  private factory: HubHandlerFactory;

  // private logger: Logger; // Uncomment when logging is needed

  constructor(factory: HubHandlerFactory) {
    this.factory = factory;
    // this.logger = factory.getLogger(); // Uncomment when logging is needed
  }

  /**
   * 处理证书交换
   */
  async handleExchangeCertificates(params: RPCParams<'edge.exchangeCertificates'>): Promise<RPCResult<'edge.exchangeCertificates'>> {
    // 注册证书
    await this.factory.getCertExchange().registerCertificate(params.server_id, params.certificate);
    return { success: true };
  }
}