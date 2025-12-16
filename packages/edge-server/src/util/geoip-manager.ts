import type { Logger } from 'winston';
import { TypedEventEmitter, type EventMap } from '@munode/common';
import { EdgeConfig, GeoIPResult } from '../types.js';
import { Reader, ReaderModel } from '@maxmind/geoip2-node';

interface MaxMindCityResponse {
  country?: {
    isoCode?: string;
    names?: {
      en?: string;
    };
  };
  continent?: {
    code?: string;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    timeZone?: string;
  };
  traits?: {
    isp?: string;
  };
  city?: {
    names?: {
      en?: string;
    };
  };
}

interface CacheStats {
  cacheSize: number;
}

/**
 * GeoIPManager 事件类型定义
 */
export interface GeoIPManagerEvents extends EventMap {
  // GeoIPManager 当前没有发出事件，保留用于未来扩展
}

/**
 * GeoIP 管理器 - 处理IP地理位置查询
 */
export class GeoIPManager extends TypedEventEmitter<GeoIPManagerEvents> {
  // private config: EdgeConfig;
  private logger: Logger;
  private reader?: ReaderModel;
  private cache: Map<string, GeoIPResult> = new Map();

  constructor(_config: EdgeConfig, logger: Logger) {
    super();
    // this.config = config;
    this.logger = logger;
  }

  /**
   * 初始化 GeoIP 管理器
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing GeoIPManager...');

    try {
      // 加载 GeoIP 数据库
      // 注意：需要下载 GeoLite2-City.mmdb 文件
      this.reader = await Reader.open('./data/GeoLite2-City.mmdb');
      this.logger.info('GeoIP database loaded successfully');
    } catch (error) {
      this.logger.warn('Failed to load GeoIP database (optional feature):', error);
      // Don't throw error - GeoIP is optional and server can work without it
      this.logger.info('GeoIPManager will continue without database');
    }
  }

  /**
   * 查询IP地理位置
   */
  async lookup(ip: string): Promise<GeoIPResult | null> {
    // 检查缓存
    const cached = this.cache.get(ip);
    if (cached) {
      return cached;
    }

    if (!this.reader) {
      return null;
    }

    try {
      const response = this.reader.city(ip) as MaxMindCityResponse;

      const result: GeoIPResult = {
        ip,
        countryCode: response.country?.isoCode || '',
        country: response.country?.names?.en || '',
        continentCode: response.continent?.code || '',
        latitude: response.location?.latitude || 0,
        longitude: response.location?.longitude || 0,
        asn: 0, // 需要 ASN 数据库
        organization: response.traits?.isp || '',
        timezone: response.location?.timeZone || '',
      };

      // 缓存结果
      this.cache.set(ip, result);

      return result;
    } catch (error) {
      this.logger.debug(`GeoIP lookup failed for ${ip}:`, error);
      return null;
    }
  }

  /**
   * 批量查询IP地理位置
   */
  async lookupBatch(ips: string[]): Promise<Map<string, GeoIPResult | null>> {
    const results = new Map<string, GeoIPResult | null>();

    for (const ip of ips) {
      const result = await this.lookup(ip);
      results.set(ip, result);
    }

    return results;
  }

  /**
   * 检查IP是否在中国
   */
  async isChineseIP(ip: string): Promise<boolean> {
    const result = await this.lookup(ip);
    return result?.countryCode === 'CN';
  }

  /**
   * 获取IP所在地区
   */
  async getRegion(ip: string): Promise<string> {
    const result = await this.lookup(ip);
    return result?.country || 'Unknown';
  }

  /**
   * 获取IP所在城市
   */
  async getCity(ip: string): Promise<string> {
    if (!this.reader) {
      return 'Unknown';
    }

    try {
      const response = this.reader.city(ip) as MaxMindCityResponse;
      return response.city?.names?.en || 'Unknown';
    } catch (_error) {
      return 'Unknown';
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('GeoIP cache cleared');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): CacheStats {
    return {
      cacheSize: this.cache.size,
    };
  }

  /**
   * 检查数据库是否已加载
   */
  isReady(): boolean {
    return this.reader !== undefined;
  }
}
