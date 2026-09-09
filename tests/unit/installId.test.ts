/**
 * installId - one id per browser install, shared by push and the daily bonus.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_ID_KEY, installId } from '../../src/lib/installId';

describe('installId', () => {
  beforeEach(() => localStorage.clear());

  it('mints one id and returns the same one afterwards, under the push subscription key', () => {
    const a = installId();
    const b = installId();
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(localStorage.getItem(INSTALL_ID_KEY)).toBe(a);
    expect(INSTALL_ID_KEY).toBe('smarter-poker-push-device-id');
  });

  it('keeps an id the push client already minted, and replaces a malformed one', () => {
    localStorage.setItem(INSTALL_ID_KEY, 'abcdef12-3456');
    expect(installId()).toBe('abcdef12-3456');
    localStorage.setItem(INSTALL_ID_KEY, 'not valid!');
    const fresh = installId();
    expect(fresh).not.toBe('not valid!');
    expect(fresh).toMatch(/^[a-z0-9-]{8,64}$/i);
  });
});
