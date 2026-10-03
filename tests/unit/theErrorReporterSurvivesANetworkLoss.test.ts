/**
 * A network loss at the table must not turn the error reporter into the bug
 * (2026-10-03, post-deploy live-table certificate: "MTT/SPIN/SNG did not
 * acknowledge the forced network loss").
 *
 * #5938 made reportError lazily import the first-party sink on the first
 * error. The first error of a network loss is the table's own failed read, so
 * the import ran with no network. Vite handed the failure to the stale-chunk
 * recovery, which cancelled the event, so the import RESOLVED with undefined;
 * `m.clientErrorSink` threw, the cached load rejected for good, and every
 * later error became an unhandled rejection that main.tsx reported straight
 * back into reportError. The production trace holds 56,758 of them in 15
 * seconds, and the "Reconnecting To The Table" banner never painted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SINK = '../../src/utils/clientErrorSink';
const REPORTER = '../../src/utils/errorReporter';

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the error reporter survives a network loss', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://sink.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.doUnmock(SINK);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete (window.navigator as { onLine?: boolean }).onLine;
  });

  it('does not fetch the sink while offline, and fetches it once the network is back', async () => {
    const enqueue = vi.fn();
    const loaded = vi.fn();
    vi.doMock(SINK, () => {
      loaded();
      return { clientErrorSink: { enqueue } };
    });
    const { reportError } = await import(REPORTER);

    setOnline(false);
    reportError(new TypeError('Load failed'), 'TablePage.hole_card_recovery_read_failed');
    await settle();
    expect(loaded).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    setOnline(true);
    reportError(new Error('after the outage'), 'TablePage.after_outage');
    await settle();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ source: 'TablePage.after_outage' });
  });

  it('a sink load that comes back unusable never produces an unhandled rejection', async () => {
    // What the recovery leaves behind: evaluating `.clientErrorSink` throws.
    vi.doMock(SINK, () => ({
      get clientErrorSink(): never {
        throw new TypeError("undefined is not an object (evaluating 'e.clientErrorSink')");
      },
    }));
    const { reportError, captureClientError } = await import(REPORTER);

    setOnline(true);
    for (let i = 0; i < 5; i++) {
      reportError(new TypeError('Load failed'), 'TablePage.hole_card_recovery_read_failed');
      captureClientError(new Error('shown'), 'Toast.error.shown');
    }
    await settle();
    expect(unhandled).toEqual([]);
  });
});
