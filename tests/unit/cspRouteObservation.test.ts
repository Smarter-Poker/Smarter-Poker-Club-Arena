import type { BrowserContext, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { visitCspRoute, visitIsolatedCspRoute } from '../e2e/support/cspRouteObservation';

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

describe('CSP route page isolation', () => {
  function isolatedHarness(failAt?: 'collector' | 'navigation') {
    const pages: Array<{ close: ReturnType<typeof vi.fn>; goto: ReturnType<typeof vi.fn> }> = [];
    const events: string[] = [];
    const context = {
      newPage: vi.fn(async () => {
        const id = pages.length;
        const page = {
          ...readyApp,
          addInitScript: vi.fn(async () => {
            events.push(`collector:${id}`);
            if (failAt === 'collector') throw new Error('collector setup failed');
          }),
          goto: vi.fn(async () => {
            events.push(`document:${id}`);
            if (failAt === 'navigation') throw new Error('net::ERR_ABORTED');
            return readyDocument;
          }),
          waitForTimeout: vi.fn(),
          evaluate: vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce([
              { directive: 'img-src', blockedURI: `route:${id}`, disposition: 'report' },
            ]),
          close: vi.fn(async () => {
            events.push(`close:${id}`);
          }),
        };
        pages.push(page);
        return page;
      }),
    };
    return { context: context as unknown as BrowserContext, pages, events };
  }

  it('collects each first document in a fresh page without replacing prior route evidence', async () => {
    const h = isolatedHarness();
    const collect = () => {};
    const first = await visitIsolatedCspRoute(
      h.context,
      'https://example.invalid/first',
      'hub:/first',
      collect
    );
    const second = await visitIsolatedCspRoute(
      h.context,
      'https://example.invalid/second',
      'hub:/second',
      collect
    );
    expect([...first, ...second].map((v) => v.blockedURI)).toEqual(['route:0', 'route:1']);
    expect(h.events).toEqual([
      'collector:0',
      'document:0',
      'close:0',
      'collector:1',
      'document:1',
      'close:1',
    ]);
    for (const page of h.pages) {
      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(page.close).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['collector', 'navigation'] as const)(
    'closes the owned page and rejects %s failures',
    async (failAt) => {
      const h = isolatedHarness(failAt);
      await expect(
        visitIsolatedCspRoute(h.context, 'https://example.invalid/', 'hub:/', () => {})
      ).rejects.toThrow(failAt === 'collector' ? 'collector setup failed' : 'net::ERR_ABORTED');
      expect(h.pages).toHaveLength(1);
      expect(h.pages[0].goto).toHaveBeenCalledTimes(failAt === 'collector' ? 0 : 1);
      expect(h.pages[0].close).toHaveBeenCalledTimes(1);
    }
  );
});
