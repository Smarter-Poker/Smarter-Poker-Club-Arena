/**
 * src/lib/appBase.ts is the one seam between the web sub-path and the native
 * root. On the web every derived value must equal the literal it replaced, or
 * the app is a white screen (React Router renders an empty tree, not a 404,
 * when the basename does not match the URL).
 */
import { describe, it, expect } from 'vitest';
import { normaliseBase, routerBasenameFrom, webAppUrl, WEB_APP_URL } from '../../src/lib/appBase';

describe('appBase: the web values are the literals they replaced', () => {
  it('web base -> web basename', () => {
    expect(routerBasenameFrom('/hub/club-arena/')).toBe('/hub/club-arena');
    expect(routerBasenameFrom('/hub/club-arena')).toBe('/hub/club-arena');
  });
  it('native base -> root basename', () => {
    expect(routerBasenameFrom('/')).toBe('/');
    expect(routerBasenameFrom('./')).toBe('/');
    expect(routerBasenameFrom('')).toBe('/');
    expect(routerBasenameFrom(undefined as unknown as string)).toBe('/');
  });
  it('normaliseBase always carries a trailing slash', () => {
    expect(normaliseBase('/hub/club-arena')).toBe('/hub/club-arena/');
    expect(normaliseBase('/hub/club-arena/')).toBe('/hub/club-arena/');
    expect(normaliseBase('/')).toBe('/');
  });
  it('a web link is a web link on every target', () => {
    expect(WEB_APP_URL).toBe('https://smarter.poker/hub/club-arena');
    expect(webAppUrl('/clubs/abc')).toBe('https://smarter.poker/hub/club-arena/clubs/abc');
    expect(webAppUrl('hand-history?hand=x')).toBe(
      'https://smarter.poker/hub/club-arena/hand-history?hand=x'
    );
    expect(webAppUrl()).toBe('https://smarter.poker/hub/club-arena');
  });
});
