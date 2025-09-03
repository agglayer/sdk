/**
 * Generic HTTP Client
 */

export interface RequestConfig {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface Response<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  ok: boolean;
}

export interface HttpClientConfig {
  baseUrl: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  defaultHeaders?: Record<string, string>;
}

interface FetchConfig {
  method: string;
  headers?: Headers;
  body?: string;
  signal?: AbortSignal;
}

export class HttpClient {
  private config: HttpClientConfig;

  constructor(config: HttpClientConfig) {
    this.config = {
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
      ...config,
    };
  }

  async request<T>(url: string, config: RequestConfig): Promise<Response<T>> {
    const fullUrl = this.buildUrl(url);
    const requestConfig = this.buildRequestConfig(config);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= (this.config.retries ?? 3); attempt++) {
      try {
        const response = await this.makeRequest<T>(fullUrl, requestConfig);
        return response;
      } catch (error) {
        lastError = error as Error;

        if (
          attempt === (this.config.retries ?? 3) ||
          !this.isRetryableError(error)
        ) {
          break;
        }

        if (attempt < (this.config.retries ?? 3)) {
          await this.delay(
            (this.config.retryDelay ?? 1000) * Math.pow(2, attempt)
          );
        }
      }
    }

    throw new Error(
      `Request failed after ${this.config.retries ?? 3} retries: ${lastError?.message ?? 'Unknown error'}`
    );
  }

  async get<T>(
    url: string,
    params?: Record<string, unknown>
  ): Promise<Response<T>> {
    const queryString = params ? this.buildQueryString(params) : '';
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    return this.request<T>(fullUrl, { method: 'GET' });
  }

  async post<T>(
    url: string,
    data?: unknown,
    config?: Partial<RequestConfig>
  ): Promise<Response<T>> {
    return this.request<T>(url, {
      method: 'POST',
      body: data,
      ...config,
    });
  }

  private buildUrl(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return `${this.config.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
  }

  private buildRequestConfig(config: RequestConfig): FetchConfig {
    const headers = new Headers(this.config.defaultHeaders);

    if (config.headers) {
      Object.entries(config.headers).forEach(([key, value]) => {
        headers.set(key, value);
      });
    }

    const requestConfig: FetchConfig = {
      method: config.method,
      headers,
    };

    if (config.body) {
      if (typeof config.body === 'string') {
        requestConfig.body = config.body;
      } else {
        requestConfig.body = JSON.stringify(config.body);
      }
    }

    return requestConfig;
  }

  private async makeRequest<T>(
    url: string,
    config: FetchConfig
  ): Promise<Response<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...config,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let data: T;
      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as T;
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        ok: response.ok,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }

      throw error;
    }
  }

  private buildQueryString(params: Record<string, unknown>): string {
    const flattenedParams = this.flattenParams(params);

    return Object.entries(flattenedParams)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      )
      .join('&');
  }

  private flattenParams(
    params: Record<string, unknown>,
    prefix = ''
  ): Record<string, string | number> {
    const result: Record<string, string | number> = {};

    for (const [key, value] of Object.entries(params)) {
      const fullKey = prefix ? `${prefix}[${key}]` : key;

      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item !== undefined && item !== null) {
            result[`${fullKey}[${index}]`] = String(item);
          }
        });
      } else if (typeof value === 'object') {
        Object.assign(
          result,
          this.flattenParams(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = String(value);
      }
    }

    return result;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('fetch')
      );
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
