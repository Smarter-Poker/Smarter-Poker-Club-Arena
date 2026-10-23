/**
 * A STALE CHUNK IS NOT A CRASH (client_crash_log 3015, 2026-10-23).
 *
 * An iPhone at a live table hit "Importing a module script failed." after a
 * publish. The tab had already spent its reload budget on an earlier publish
 * (the URL still carried that recovery's `_cb`), so lazyWithRetry rethrew,
 * the table's TableErrorBoundary caught it and wrote client_crash_log with
 * boundary 'page' - a digest "app crash" for a deploy the page could have
 * recovered from.
 *
 * Contract pinned here:
 * - every browser's wording of a failed dynamic import is recognized;
 * - each build gets exactly one guarded hard reload, keyed by build in
 *   sessionStorage, so the next publish gets its own and a broken build
 *   cannot loop;
 * - every boundary that writes client_crash_log hands a chunk error to that
 *   recovery and never records it as a crash; a genuine render error is still
 *   recorded exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const reportClientCrash = vi.fn(async () => true);
vi.mock('../../src/utils/reportClientCrash', () => ({ reportClientCrash }));

type Recovery = typeof import('../../src/utils/lazyWithRetry');
let recovery: Recovery;
let TableErrorBoundary: typeof import('../../src/components/common/TableErrorBoundary').TableErrorBoundary;
let PageErrorBoundary: typeof import('../../src/components/common/PageErrorBoundary').PageErrorBoundary;
let PanelBoundary: typeof import('../../src/components/stats/PanelBoundary').PanelBoundary;

// Each test is a fresh document: recovery's in-memory "already navigating"
// flag must not leak from one test into the next.
async function freshDocument(): Promise<void> {
  vi.resetModules();
  recovery = await import('../../src/utils/lazyWithRetry');
  ({ TableErrorBoundary } = await import('../../src/components/common/TableErrorBoundary'));
  ({ PageErrorBoundary } = await import('../../src/components/common/PageErrorBoundary'));
  ({ PanelBoundary } = await import('../../src/components/stats/PanelBoundary'));
}
const chunkReloadGuardKey = () => recovery.chunkReloadGuardKey();
const claimChunkErrorForBoundary = (e: unknown) => recovery.claimChunkErrorForBoundary(e);
const isChunkLoadError = (e: unknown) => recovery.isChunkLoadError(e);

const WEBKIT = () => new TypeError('Importing a module script failed.');
const CHROME = () =>
  new TypeError('Failed to fetch dynamically imported module: /assets/TablePage-old-v6.js');
const FIREFOX = () =>
  new TypeError('error loading dynamically imported module: /assets/TablePage-old-v6.js');

function Thrower({ error }: { error: Error }): never {
  throw error;
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('stale chunk errors at the error boundaries', () => {
  let replace: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(async () => {
    await freshDocument();
    sessionStorage.clear();
    reportClientCrash.mockClear();
    replace = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'https://smarter.poker/hub/club-arena/table/b76b40a0',
        pathname: '/hub/club-arena/table/b76b40a0',
        replace,
        reload: vi.fn(),
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    ['WebKit', WEBKIT],
    ['Chromium', CHROME],
    ['Firefox', FIREFOX],
  ])('recognizes the %s wording of a failed dynamic import', (_name, make) => {
    expect(isChunkLoadError(make())).toBe(true);
  });

  it('keys the one-reload guard by build', () => {
    expect(chunkReloadGuardKey()).toMatch(/^club_arena_chunk_reload:.+/);
  });

  it('a stale chunk at the table reloads once and is never logged as a crash', async () => {
    const { container } = render(
      <TableErrorBoundary componentName="TablePage(b76b40a0)" fallback={<p>crashed</p>}>
        <Thrower error={WEBKIT()} />
      </TableErrorBoundary>
    );
    await flush();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(String(replace.mock.calls[0][0])).toContain('_cb=');
    expect(reportClientCrash).not.toHaveBeenCalled();
    // Nothing paints while the document is replaced: no crash card.
    expect(container.textContent).not.toContain('crashed');
    expect(sessionStorage.getItem(chunkReloadGuardKey())).toBe('1');
  });

  it.each([
    [
      'PageErrorBoundary',
      (error: Error) => (
        <PageErrorBoundary pageName="Table">
          <Thrower error={error} />
        </PageErrorBoundary>
      ),
    ],
    [
      'PanelBoundary',
      (error: Error) => (
        <PanelBoundary name="Heatmap">
          <Thrower error={error} />
        </PanelBoundary>
      ),
    ],
  ])('%s hands a stale chunk to recovery instead of client_crash_log', async (_n, tree) => {
    render(tree(CHROME()));
    await flush();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(reportClientCrash).not.toHaveBeenCalled();
  });

  it('does not reload a second time for the same build, and still does not log a crash', async () => {
    sessionStorage.setItem(chunkReloadGuardKey(), '1');
    expect(claimChunkErrorForBoundary(FIREFOX())).toBe('exhausted');
    const { container } = render(
      <TableErrorBoundary componentName="TablePage(b76b40a0)" fallback={<p>Table Not Displayed</p>}>
        <Thrower error={WEBKIT()} />
      </TableErrorBoundary>
    );
    await flush();
    expect(replace).not.toHaveBeenCalled();
    expect(reportClientCrash).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Table Not Displayed');
  });

  it('a spent guard from an older build or the retired per-tab counter does not block this build', async () => {
    sessionStorage.setItem('club_arena_chunk_reload', '2');
    sessionStorage.setItem('club_arena_chunk_reload:an-older-build', '1');
    sessionStorage.setItem('ca-chunk-hardreload', '1');
    expect(claimChunkErrorForBoundary(WEBKIT())).toBe('recovering');
    await flush();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('a genuine render error is still recorded as a crash', async () => {
    render(
      <TableErrorBoundary componentName="TablePage(b76b40a0)" fallback={<p>crashed</p>}>
        <Thrower error={new TypeError("Cannot read properties of undefined (reading 'seat')")} />
      </TableErrorBoundary>
    );
    await flush();
    expect(replace).not.toHaveBeenCalled();
    expect(reportClientCrash).toHaveBeenCalledTimes(1);
    expect(claimChunkErrorForBoundary(new Error('wallet reconciliation failed'))).toBe('not-chunk');
  });
});
