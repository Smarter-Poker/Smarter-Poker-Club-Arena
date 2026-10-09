import { describe, expect, it, vi } from 'vitest';
import type { APIRequestContext } from '@playwright/test';
import { readStylesheetBatches } from '../e2e/lib/stylesheet-batches';
import { readFileSync } from 'node:fs';

const names = Array.from({ length: 13 }, (_, i) => `assets/route-${i}.css`);

function fixture(failure?: 'status' | 'request' | 'body') {
  let active = 0;
  let peak = 0;
  const requested: string[] = [];
  const finished: string[] = [];
  const get = vi.fn(async (url: string) => {
    const name = url.replace('https://fixture/', '');
    const index = names.indexOf(name);
    requested.push(name);
    active++;
    peak = Math.max(peak, active);
    if (active > 4) throw new Error('unbounded request burst');
    if (index === 5 && failure === 'request') throw new Error('request failed');
    return {
      ok: () => !(index === 5 && failure === 'status'),
      status: () => 503,
      text: async () => {
        for (let turn = 0; turn < 4 - (index % 4); turn++) await Promise.resolve();
        active--;
        finished.push(name);
        if (index === 5 && failure === 'body') throw new Error('body failed');
        return `/* ${name} */ .fixture { color: red; }`;
      },
    };
  });
  return {
    request: { get } as unknown as Pick<APIRequestContext, 'get'>,
    requested,
    finished,
    peak: () => peak,
    active: () => active,
  };
}

describe('the mobile CSS fixture keeps the complete bounded cascade', () => {
  it('holds at most four requests including their bodies and preserves all discovery order', async () => {
    const f = fixture();
    const css = await readStylesheetBatches(f.request, 'https://fixture', names);
    expect(f.peak()).toBe(4);
    expect(f.active()).toBe(0);
    expect(f.requested).toEqual(names);
    expect(f.finished).not.toEqual(names);
    expect(css).toEqual(names.map((name) => `/* ${name} */ .fixture { color: red; }`));
  });

  it.each([
    ['status', 'stylesheet assets/route-5.css must load: HTTP 503'],
    ['request', 'request failed'],
    ['body', 'body failed'],
  ] as const)(
    'refuses a failed %s without returning partial CSS, retrying, or starting later batches',
    async (failure, message) => {
      const f = fixture(failure);
      await expect(readStylesheetBatches(f.request, 'https://fixture', names)).rejects.toThrow(
        message
      );
      expect(f.requested).toEqual(names.slice(0, 8));
      expect(f.peak()).toBeLessThanOrEqual(4);
    }
  );

  it('wires the mobile fixture to the strict reader before installing any styles', () => {
    const source = readFileSync('tests/e2e/card-squeeze-mobile.spec.ts', 'utf8');
    expect(source).toContain("from './lib/stylesheet-batches'");
    expect(source).toContain('await readStylesheetBatches(page.request, ARENA, [...names])');
    expect(source.indexOf('await readStylesheetBatches')).toBeLessThan(
      source.indexOf('await page.addStyleTag')
    );
    expect(source).not.toContain('const styles = await Promise.all(');
  });
});
