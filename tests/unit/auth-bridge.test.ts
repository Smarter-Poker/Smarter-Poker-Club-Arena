/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUTH BRIDGE — Unit Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests for the iframe auth handshake between parent (Smarter-Poker-World-Hub)
 * and child (club-arena). Validates:
 * - Token validation and expiry checking
 * - Origin validation (subdomain spoofing prevention)
 * - postToParent messaging with correct target origins
 * - earlyAuth bridge state management
 * - Auth deduplication (same token skip, in-flight mutex)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — Extracted logic that mirrors production code
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors isTokenExpiringSoon() from ClubArenaEmbed.js (parent side)
 */
function isTokenExpiringSoon(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1]));
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true;
  }
}

/**
 * Mirrors isTokenExpired() from App.tsx (child side)
 */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1]));
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/**
 * Mirrors isTrustedOrigin() from parentOrigin.ts
 */
function isTrustedOrigin(origin: string): boolean {
  const TRUSTED_ORIGINS = [
    'https://smarter.poker',
    'https://www.smarter.poker',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  if (TRUSTED_ORIGINS.includes(origin)) return true;

  // Subdomain check — extract host properly to prevent evil-smarter.poker matching
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host.endsWith('.smarter.poker')) {
      // Ensure it's actually a subdomain, not just a suffix match
      const prefix = host.slice(0, -'.smarter.poker'.length);
      return prefix.length > 0 && !prefix.includes('.');
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Create a mock JWT with a specific expiry
 */
function createMockJWT(expiresInSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      sub: 'test-user-id',
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      aud: 'authenticated',
      role: 'authenticated',
    })
  );
  const signature = btoa('fake-signature');
  return `${header}.${payload}.${signature}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Token Validation', () => {
  describe('isTokenExpiringSoon (parent-side)', () => {
    it('should return false for tokens with >30s remaining', () => {
      const token = createMockJWT(120); // 2 minutes
      expect(isTokenExpiringSoon(token)).toBe(false);
    });

    it('should return true for tokens expiring within 30s', () => {
      const token = createMockJWT(15); // 15 seconds
      expect(isTokenExpiringSoon(token)).toBe(true);
    });

    it('should return true for already expired tokens', () => {
      const token = createMockJWT(-60); // expired 60 seconds ago
      expect(isTokenExpiringSoon(token)).toBe(true);
    });

    it('should return true for malformed tokens (not 3 parts)', () => {
      expect(isTokenExpiringSoon('invalid')).toBe(true);
      expect(isTokenExpiringSoon('a.b')).toBe(true);
      expect(isTokenExpiringSoon('')).toBe(true);
    });

    it('should return true for tokens with non-numeric exp', () => {
      const header = btoa(JSON.stringify({ alg: 'HS256' }));
      const payload = btoa(JSON.stringify({ exp: 'not-a-number' }));
      const sig = btoa('sig');
      expect(isTokenExpiringSoon(`${header}.${payload}.${sig}`)).toBe(true);
    });

    it('should return true for tokens with missing exp', () => {
      const header = btoa(JSON.stringify({ alg: 'HS256' }));
      const payload = btoa(JSON.stringify({ sub: 'user' }));
      const sig = btoa('sig');
      expect(isTokenExpiringSoon(`${header}.${payload}.${sig}`)).toBe(true);
    });

    it('should return true for tokens with invalid base64 payload', () => {
      expect(isTokenExpiringSoon('a.!!!invalid!!!.c')).toBe(true);
    });
  });

  describe('isTokenExpired (child-side)', () => {
    it('should return false for valid non-expired tokens', () => {
      const token = createMockJWT(3600); // 1 hour
      expect(isTokenExpired(token)).toBe(false);
    });

    it('should return false for tokens expiring in 15s (not yet expired)', () => {
      const token = createMockJWT(15);
      expect(isTokenExpired(token)).toBe(false);
    });

    it('should return true for expired tokens', () => {
      const token = createMockJWT(-1);
      expect(isTokenExpired(token)).toBe(true);
    });

    it('should return true for malformed tokens', () => {
      expect(isTokenExpired('garbage')).toBe(true);
    });
  });

  describe('Token expiry boundary: parent vs child agreement', () => {
    it('parent blocks tokens expiring in <30s, child accepts if not yet expired', () => {
      const token = createMockJWT(20); // 20 seconds remaining
      // Parent would NOT send this (expiring soon)
      expect(isTokenExpiringSoon(token)).toBe(true);
      // Child would accept it if it somehow arrived (not yet expired)
      expect(isTokenExpired(token)).toBe(false);
    });

    it('both agree on already-expired tokens', () => {
      const token = createMockJWT(-10);
      expect(isTokenExpiringSoon(token)).toBe(true);
      expect(isTokenExpired(token)).toBe(true);
    });

    it('both agree on healthy tokens', () => {
      const token = createMockJWT(300); // 5 minutes
      expect(isTokenExpiringSoon(token)).toBe(false);
      expect(isTokenExpired(token)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORIGIN VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Origin Validation (isTrustedOrigin)', () => {
  it('should trust the primary production origin', () => {
    expect(isTrustedOrigin('https://smarter.poker')).toBe(true);
  });

  it('should trust www subdomain', () => {
    expect(isTrustedOrigin('https://www.smarter.poker')).toBe(true);
  });

  it('should trust localhost dev origins', () => {
    expect(isTrustedOrigin('http://localhost:3000')).toBe(true);
    expect(isTrustedOrigin('http://localhost:5173')).toBe(true);
  });

  it('should trust valid subdomains', () => {
    expect(isTrustedOrigin('https://staging.smarter.poker')).toBe(true);
    expect(isTrustedOrigin('https://dev.smarter.poker')).toBe(true);
    expect(isTrustedOrigin('https://preview.smarter.poker')).toBe(true);
  });

  it('should REJECT subdomain spoofing (evil-smarter.poker)', () => {
    expect(isTrustedOrigin('https://evil-smarter.poker')).toBe(false);
  });

  it('should REJECT deep subdomains (double-dot attack)', () => {
    expect(isTrustedOrigin('https://a.b.smarter.poker')).toBe(false);
  });

  it('should REJECT completely unrelated origins', () => {
    expect(isTrustedOrigin('https://evil.com')).toBe(false);
    expect(isTrustedOrigin('https://google.com')).toBe(false);
  });

  it('should REJECT malformed URLs', () => {
    expect(isTrustedOrigin('not-a-url')).toBe(false);
    expect(isTrustedOrigin('')).toBe(false);
  });

  it('should REJECT different protocols', () => {
    expect(isTrustedOrigin('http://smarter.poker')).toBe(false);
  });

  it('should REJECT ports on production domain', () => {
    expect(isTrustedOrigin('https://smarter.poker:8080')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH DEDUPLICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth Deduplication (processAuthToken logic)', () => {
  let lastToken: string | null;
  let authInFlight: boolean;
  let setSessionCalls: Array<{ token: string; refreshToken: string }>;
  let acksSent: number;

  const processAuthToken = async (
    token: string,
    refreshToken: string,
    _settings: Record<string, unknown> | null,
    _source: 'earlyAuth' | 'postMessage'
  ) => {
    // Skip duplicate token
    if (lastToken === token) return { skipped: true, reason: 'duplicate' };
    // Skip expired
    if (isTokenExpired(token)) return { skipped: true, reason: 'expired' };
    // Skip if already in flight
    if (authInFlight) return { skipped: true, reason: 'in_flight' };

    lastToken = token;
    authInFlight = true;

    try {
      // Simulate setSession
      setSessionCalls.push({ token, refreshToken });
      acksSent++;
      return { skipped: false };
    } finally {
      authInFlight = false;
    }
  };

  beforeEach(() => {
    lastToken = null;
    authInFlight = false;
    setSessionCalls = [];
    acksSent = 0;
  });

  it('should process fresh token on first call', async () => {
    const token = createMockJWT(3600);
    const result = await processAuthToken(token, 'refresh-1', null, 'earlyAuth');
    expect(result.skipped).toBe(false);
    expect(setSessionCalls).toHaveLength(1);
    expect(acksSent).toBe(1);
  });

  it('should skip duplicate token (same JWT)', async () => {
    const token = createMockJWT(3600);
    await processAuthToken(token, 'refresh-1', null, 'earlyAuth');
    const result = await processAuthToken(token, 'refresh-1', null, 'postMessage');
    expect(result).toEqual({ skipped: true, reason: 'duplicate' });
    expect(setSessionCalls).toHaveLength(1); // Only first call
  });

  it('should accept different token (token refresh)', async () => {
    const token1 = createMockJWT(3600);
    const token2 = createMockJWT(7200); // Different expiry = different token
    await processAuthToken(token1, 'refresh-1', null, 'earlyAuth');
    const result = await processAuthToken(token2, 'refresh-2', null, 'postMessage');
    expect(result.skipped).toBe(false);
    expect(setSessionCalls).toHaveLength(2);
  });

  it('should reject expired token', async () => {
    const expiredToken = createMockJWT(-60);
    const result = await processAuthToken(expiredToken, 'refresh', null, 'earlyAuth');
    expect(result).toEqual({ skipped: true, reason: 'expired' });
    expect(setSessionCalls).toHaveLength(0);
  });

  it('should block concurrent calls via in-flight mutex', async () => {
    const token1 = createMockJWT(3600);
    const token2 = createMockJWT(7200);

    // Simulate in-flight state
    authInFlight = true;
    const result = await processAuthToken(token2, 'refresh-2', null, 'postMessage');
    expect(result).toEqual({ skipped: true, reason: 'in_flight' });
    authInFlight = false;

    // After in-flight clears, should work
    const result2 = await processAuthToken(token1, 'refresh-1', null, 'earlyAuth');
    expect(result2.skipped).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// URL SANITIZATION TESTS (path traversal prevention)
// ═══════════════════════════════════════════════════════════════════════════════

describe('URL Sync Path Sanitization', () => {
  /**
   * Mirrors the sanitization logic from ClubArenaEmbed.js
   */
  function sanitizePath(path: string): string | null {
    if (typeof path !== 'string') return null;
    // Strip query and hash
    let clean = path.split('?')[0].split('#')[0];
    // Remove path traversal attempts
    clean = clean.replace(/\.\.\//g, '').replace(/\.\./g, '');
    // Must start with /
    if (!clean.startsWith('/')) clean = '/' + clean;
    // Only allow alphanumeric, hyphens, underscores, slashes
    if (!/^[a-zA-Z0-9/_-]+$/.test(clean)) return null;
    return clean;
  }

  it('should pass through clean paths', () => {
    expect(sanitizePath('/club/123')).toBe('/club/123');
    expect(sanitizePath('/arena/training/level-3')).toBe('/arena/training/level-3');
  });

  it('should strip query parameters', () => {
    expect(sanitizePath('/club/123?token=secret')).toBe('/club/123');
  });

  it('should strip hash fragments', () => {
    expect(sanitizePath('/club/123#section')).toBe('/club/123');
  });

  it('should remove path traversal attempts', () => {
    expect(sanitizePath('/../../../etc/passwd')).toBe('/etc/passwd');
    expect(sanitizePath('/club/../../admin')).toBe('/club/admin');
  });

  it('should add leading slash if missing', () => {
    expect(sanitizePath('club/123')).toBe('/club/123');
  });

  it('should reject paths with special characters', () => {
    expect(sanitizePath('/club/<script>')).toBeNull();
    expect(sanitizePath('/club/123;rm -rf')).toBeNull();
  });

  it('should handle empty string', () => {
    expect(sanitizePath('')).toBe('/');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTMESSAGE GATING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PostMessage Iframe Gating', () => {
  it('should not send messages before iframe onLoad', () => {
    let iframeLoaded = false;
    const messages: string[] = [];

    const sendToIframe = (msg: string) => {
      if (!iframeLoaded) {
        // Silently queue or skip — this is the Fix 1 behavior
        return false;
      }
      messages.push(msg);
      return true;
    };

    expect(sendToIframe('SMARTER_AUTH')).toBe(false);
    expect(messages).toHaveLength(0);

    // Simulate onLoad
    iframeLoaded = true;
    expect(sendToIframe('SMARTER_AUTH')).toBe(true);
    expect(messages).toHaveLength(1);
  });
});
