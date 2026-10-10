import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { visitCspRoute } from '../e2e/support/cspRouteObservation';

describe('CSP route document observation', () => {
  it('collects the same document after both full lazy-resource observation windows', async () => {
    const events: string[] = [];
    const violations = [
      { directive: 'img-src', blockedURI: 'https://unexpected.invalid/art', disposition: 'report' },
    ];
    const page = {
      goto: vi.fn(async () => {
        events.push('document');
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
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure),
    };
    await expect(visitCspRoute(page as unknown as Page, 'https://example.invalid/')).rejects.toBe(
      failure
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
