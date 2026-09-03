/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  API — Fetch Wrapper & API Utilities
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
  status: number;
}

export interface ApiError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface RequestConfig extends Omit<RequestInit, 'body'> {
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a configured API client
 */
export function createApiClient(baseUrl: string, defaultHeaders: HeadersInit = {}) {
  async function request<T>(endpoint: string, config: RequestConfig = {}): Promise<ApiResponse<T>> {
    const { body, params, timeout = 30000, headers: configHeaders, ...restConfig } = config;

    // Build URL with query params
    let url = `${baseUrl}${endpoint}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    // Prepare headers
    const headers = new Headers(defaultHeaders);
    if (configHeaders) {
      const configHeadersObj =
        configHeaders instanceof Headers
          ? Object.fromEntries(configHeaders.entries())
          : configHeaders;
      for (const [key, value] of Object.entries(configHeadersObj)) {
        if (typeof value === 'string') {
          headers.set(key, value);
        }
      }
    }
    if (body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // Setup abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...restConfig,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle response
      let data: T | null = null;
      let error: ApiError | null = null;

      const contentType = response.headers.get('Content-Type');
      if (contentType?.includes('application/json')) {
        const json = await response.json();
        if (response.ok) {
          data = json as T;
        } else {
          error = {
            message: json.message || json.error || 'Request failed',
            code: json.code,
            details: json.details,
          };
        }
      } else if (!response.ok) {
        error = { message: `HTTP ${response.status}: ${response.statusText}` };
      }

      return { data, error, status: response.status };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          return {
            data: null,
            error: { message: 'Request timeout', code: 'TIMEOUT' },
            status: 0,
          };
        }
        return {
          data: null,
          error: { message: err.message, code: 'NETWORK_ERROR' },
          status: 0,
        };
      }

      return {
        data: null,
        error: { message: 'Unknown error', code: 'UNKNOWN' },
        status: 0,
      };
    }
  }

  return {
    get: <T>(endpoint: string, config?: RequestConfig) =>
      request<T>(endpoint, { ...config, method: 'GET' }),

    post: <T>(endpoint: string, body?: unknown, config?: RequestConfig) =>
      request<T>(endpoint, { ...config, method: 'POST', body }),

    put: <T>(endpoint: string, body?: unknown, config?: RequestConfig) =>
      request<T>(endpoint, { ...config, method: 'PUT', body }),

    patch: <T>(endpoint: string, body?: unknown, config?: RequestConfig) =>
      request<T>(endpoint, { ...config, method: 'PATCH', body }),

    delete: <T>(endpoint: string, config?: RequestConfig) =>
      request<T>(endpoint, { ...config, method: 'DELETE' }),

    request,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple rate limiter using token bucket
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxRequests: number, windowMs: number) {
    this.maxTokens = maxRequests;
    this.tokens = maxRequests;
    this.refillRate = maxRequests / windowMs;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.refillRate;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHING
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Simple in-memory cache
 */
export class RequestCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private defaultTtl: number;

  constructor(defaultTtlMs = 60000) {
    this.defaultTtl = defaultTtlMs;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl = this.defaultTtl): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a debounced API call
 */
export function debounceApi<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingPromise: Promise<Awaited<ReturnType<T>>> | null = null;
  let pendingResolve: ((value: Awaited<ReturnType<T>>) => void) | null = null;
  let pendingReject: ((reason: unknown) => void) | null = null;

  return (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!pendingPromise) {
      pendingPromise = new Promise<Awaited<ReturnType<T>>>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    }

    timeoutId = setTimeout(async () => {
      try {
        const result = await fn(...args);
        pendingResolve?.(result as Awaited<ReturnType<T>>);
      } catch (error) {
        pendingReject?.(error);
      } finally {
        pendingPromise = null;
        pendingResolve = null;
        pendingReject = null;
      }
    }, delayMs);

    return pendingPromise;
  };
}

/**
 * Abort all pending requests (for cleanup)
 */
export class AbortManager {
  private controllers = new Map<string, AbortController>();

  create(key: string): AbortSignal {
    this.abort(key); // Cancel any existing request with this key
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller.signal;
  }

  abort(key: string): void {
    const controller = this.controllers.get(key);
    if (controller) {
      controller.abort();
      this.controllers.delete(key);
    }
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }
}
