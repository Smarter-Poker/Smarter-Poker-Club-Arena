/**
 * src/lib/native/deepLinks.ts turns a URL that opened the app into an in-app
 * path. parseAppUrl is pure and is what every listener feeds through.
 */
import { describe, it, expect } from 'vitest';
import { parseAppUrl } from '../../src/lib/native/deepLinks';

describe('deep links: both URL shapes reduce to one in-app path', () => {
  it('custom scheme', () => {
    expect(parseAppUrl('clubarena://clubs/abc?x=1')?.path).toBe('/clubs/abc?x=1');
    expect(parseAppUrl('clubarena://auth?mode=update')?.path).toBe('/auth?mode=update');
    expect(parseAppUrl('clubarena://')?.path).toBe('/');
  });
  it('universal / app link', () => {
    expect(parseAppUrl('https://smarter.poker/hub/club-arena/invite/c1?ref=9')?.path).toBe(
      '/invite/c1?ref=9'
    );
    expect(parseAppUrl('https://smarter.poker/hub/club-arena')?.path).toBe('/');
    expect(parseAppUrl('https://smarter.poker/hub/club-arena/')?.path).toBe('/');
  });
  it('the webview itself', () => {
    expect(parseAppUrl('capacitor://localhost/table/t1')?.path).toBe('/table/t1');
    expect(parseAppUrl('https://localhost/table/t1')?.path).toBe('/table/t1');
  });
  it('anything else is not ours', () => {
    expect(parseAppUrl('https://smarter.poker/hub/messenger')).toBeNull();
    expect(parseAppUrl('https://evil.example/hub/club-arena/x')).toBeNull();
    expect(parseAppUrl('not a url')).toBeNull();
    expect(parseAppUrl('mailto:x@y')).toBeNull();
  });
  it('carries the auth tokens a recovery link puts in the hash', () => {
    const p = parseAppUrl(
      'https://smarter.poker/hub/club-arena/auth?mode=update#access_token=a&refresh_token=r&type=recovery'
    );
    expect(p?.path).toBe('/auth?mode=update');
    expect(p?.hashParams.get('access_token')).toBe('a');
    expect(p?.hashParams.get('type')).toBe('recovery');
    expect(p?.searchParams.get('mode')).toBe('update');
  });
});
