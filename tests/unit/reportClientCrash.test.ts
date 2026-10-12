/**
 * WHERE A RENDER CRASH IS RECORDED (launch audit 2026-10-06). The boundaries
 * inserted into client_crash_log from the browser, which no browser role may
 * do; Club Arena crashes were recorded nowhere. They post to the same-origin
 * sink instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportClientCrash } from '../../src/utils/reportClientCrash';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a render crash is recorded where a browser may write', () => {
  it('posts the crash to the same-origin sink as a page boundary', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const error = new TypeError('cannot read seat of undefined');
    const ok = await reportClientCrash({
      section: 'club-arena-table:TablePage',
      error,
      componentStack: '\n    at Seat\n    at Table',
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/client-crash');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.boundary).toBe('page');
    expect(body.section).toBe('club-arena-table:TablePage');
    expect(body.errorName).toBe('TypeError');
    expect(body.message).toBe('cannot read seat of undefined');
    expect(body.componentStack).toContain('at Seat');
  });

  it('never throws, whatever the network does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(reportClientCrash({ section: 's', error: new Error('x') })).resolves.toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    );
    await expect(reportClientCrash({ section: 's', error: 'a string' })).resolves.toBe(false);
  });

  it('no boundary inserts into client_crash_log from the browser', () => {
    for (const file of [
      'src/components/common/TableErrorBoundary.tsx',
      'src/components/common/PageErrorBoundary.tsx',
      'src/components/stats/PanelBoundary.tsx',
    ]) {
      const src = readFileSync(join(__dirname, '..', '..', file), 'utf8');
      expect(src, file).not.toContain("from('client_crash_log')");
      expect(src, file).toContain('reportClientCrash({');
    }
  });
});
