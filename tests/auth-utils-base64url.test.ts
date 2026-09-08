import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import {
  AUTH_STORAGE_KEY,
  getTokenExpiry,
  parseJwtPayload,
  readLocalSession,
} from '../src/lib/authUtils';

const token = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.signature`;
const claims = { sub: 'player-a', session_id: 'login-a', exp: 4102444800, note: '???' };
beforeEach(() => localStorage.clear());

describe('Base64url session claims', () => {
  it('reads a valid JWT containing the URL-safe alphabet', () => {
    const jwt = token(claims);
    expect(jwt.split('.')[1]).toMatch(/[-_]/);
    expect(parseJwtPayload(jwt)).toEqual(claims);
    expect(getTokenExpiry(jwt)).toBe(4102444800000);
  });

  it('decodes Unicode as UTF-8 without corrupting claims', () => {
    const unicode = { ...claims, email: 'josé@example.test', user_metadata: { name: '李 🃏' } };
    expect(parseJwtPayload(token(unicode))).toEqual(unicode);
  });

  it('restores the same user and login from a valid URL-safe stored session', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ access_token: token(claims) }));
    const restored = readLocalSession();
    expect(restored?.userId).toBe('player-a');
    expect(restored?.accessToken).toBe(token(claims));
    expect(parseJwtPayload(restored!.accessToken)?.session_id).toBe('login-a');
  });

  it('still rejects expired stored sessions', () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ access_token: token({ ...claims, exp: 1 }) })
    );
    expect(readLocalSession()).toBeNull();
  });

  it.each([null, [], 'claims', 42])('rejects non-object claims %j', (value) => {
    expect(parseJwtPayload(token(value))).toBeNull();
  });

  it.each(['broken', 'e30.%%%.signature', 'e30._w.signature', 'e30.bm90LWpzb24.signature'])(
    'rejects malformed token %s',
    (value) => {
      expect(parseJwtPayload(value)).toBeNull();
    }
  );
});
