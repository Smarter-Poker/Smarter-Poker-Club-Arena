import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { visitCspRoute } from '../e2e/support/cspRouteObservation';

const readyDocument = {
  ok: () => true,
  status: () => 200,
  headers: () => ({ 'content-type': 'text/html' }),
};
const readyApp = {
  locator: () => ({ waitFor: async () => {}, innerText: async () => 'Rendered app' }),
  waitForFunction: async () => {},
};
describe('CSP route document observation', () => {
  it('collects the same document after both full lazy-resource observation windows', async () => {
    const events: string[] = [];
    const violations = [
      { directive: 'img-src', blockedURI: 'https://unexpected.invalid/art', disposition: 'report' },
    ];
    const page = {
      ...readyApp,
      goto: vi.fn(async () => {
        events.push('document');
        return readyDocument;
      }),
      waitForTimeout: vi.fn(async (ms: number) => {
        events.push(`observe:${ms}`);
      }),
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          events.push('scroll');
        })
        .mockImplementationOnce(async () => {
          events.push('collect');
          return violations;
        }),
    };
    expect(await visitCspRoute(page as unknown as Page, 'https://example.invalid/wallet')).toEqual(
      violations
    );
    expect(events).toEqual(['document', 'observe:3500', 'scroll', 'observe:2000', 'collect']);
    expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://example.invalid/wallet', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  });

  it('does not replace a failed document with a second navigation and an empty collector', async () => {
    const failure = new Error('document unavailable');
    const page = {
      ...readyApp,
      goto: vi.fn().mockRejectedValue(failure),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(),
    };
    await expect(visitCspRoute(page as unknown as Page, 'https://example.invalid/')).rejects.toBe(
      failure
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('refuses an unreadable violation collector instead of certifying zero violations', async () => {
    const failure = new Error('collector unavailable');
    const page = {
      ...readyApp,
      goto: vi.fn().mockResolvedValue(readyDocument),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure),
    };
    await expect(visitCspRoute(page as unknown as Page, 'https://example.invalid/')).rejects.toBe(
      failure
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['missing', undefined],
    ['HTTP failure', { ...readyDocument, ok: () => false }],
    ['non-HTML', { ...readyDocument, headers: () => ({ 'content-type': 'application/json' }) }],
  ])('refuses %s document before observation', async (_name, response) => {
    const page = {
      ...readyApp,
      goto: vi.fn().mockResolvedValue(response),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(),
    };
    await expect(
      visitCspRoute(page as unknown as Page, 'https://example.invalid/')
    ).rejects.toThrow();
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
  it('requires the Hub application for a Hub route and refuses rendered fallbacks', async () => {
    const locator = vi.fn(() => ({
      waitFor: async () => {},
      innerText: async () => 'This page could not be found',
    }));
    const page = {
      ...readyApp,
      locator,
      goto: vi.fn().mockResolvedValue(readyDocument),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(),
    };
    await expect(
      visitCspRoute(page as unknown as Page, 'https://example.invalid/games', 'hub:/games')
    ).rejects.toThrow('fallback');
    expect(locator).toHaveBeenCalledWith('#__next');
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
