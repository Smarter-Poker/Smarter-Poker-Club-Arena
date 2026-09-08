/**
 * src/lib/signIn.ts picks the login page for the target. Under vitest the
 * build is the web build (VITE_NATIVE unset), so every URL here is the web
 * shape and must equal, byte for byte, what the sites it replaced produced.
 */
import { describe, it, expect } from 'vitest';
import {
  signInUrl,
  toWebPath,
  toInAppPath,
  safeInAppRedirect,
  WEB_LOGIN_PATH,
} from '../../src/lib/signIn';

describe('signIn: path normalisation', () => {
  it('toWebPath adds the sub-path exactly once', () => {
    expect(toWebPath('/table/abc?x=1')).toBe('/hub/club-arena/table/abc?x=1');
    expect(toWebPath('/hub/club-arena/table/abc?x=1')).toBe('/hub/club-arena/table/abc?x=1');
    expect(toWebPath('/')).toBe('/hub/club-arena/');
    expect(toWebPath('/hub/club-arena')).toBe('/hub/club-arena');
    expect(toWebPath('table/abc')).toBe('/hub/club-arena/table/abc');
    expect(toWebPath('/hub/club-arena-other')).toBe('/hub/club-arena/hub/club-arena-other');
  });
  it('toInAppPath strips it exactly once', () => {
    expect(toInAppPath('/hub/club-arena/table/abc?x=1')).toBe('/table/abc?x=1');
    expect(toInAppPath('/table/abc?x=1')).toBe('/table/abc?x=1');
    expect(toInAppPath('/hub/club-arena')).toBe('/');
    expect(toInAppPath('/hub/club-arena/')).toBe('/');
    expect(toInAppPath('/hub/club-arena?x=1')).toBe('/?x=1');
  });
});

describe('signIn: the web login URL is what AuthGuard always produced', () => {
  it('AuthGuard shape', () => {
    expect(signInUrl('/table/abc?x=1#h')).toBe(
      `${WEB_LOGIN_PATH}?redirect=${encodeURIComponent('/hub/club-arena/table/abc?x=1#h')}`
    );
  });
  it('sessionRevoked shape, authError first', () => {
    expect(signInUrl('/hub/club-arena/table/abc?x=1', { authError: 'no_session' })).toBe(
      '/auth/login?authError=no_session&redirect=' +
        encodeURIComponent('/hub/club-arena/table/abc?x=1')
    );
  });
});

describe('signIn: the in-app redirect param is never an open redirect', () => {
  it('accepts in-app paths, in either form', () => {
    expect(safeInAppRedirect('/clubs/abc?x=1')).toBe('/clubs/abc?x=1');
    expect(safeInAppRedirect(encodeURIComponent('/hub/club-arena/clubs/abc'))).toBe('/clubs/abc');
    expect(safeInAppRedirect(null)).toBe('/');
    expect(safeInAppRedirect('')).toBe('/');
  });
  it('refuses URLs, protocol-relative paths and the auth page itself', () => {
    expect(safeInAppRedirect('https://evil.example/x')).toBe('/');
    expect(safeInAppRedirect('//evil.example/x')).toBe('/');
    expect(safeInAppRedirect('/\\evil.example')).toBe('/');
    expect(safeInAppRedirect('/auth?mode=update')).toBe('/');
    expect(safeInAppRedirect('%E0%A4%A')).toBe('/');
  });
});
