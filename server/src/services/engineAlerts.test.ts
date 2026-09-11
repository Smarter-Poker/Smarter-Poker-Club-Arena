/**
 * AN ALERT THAT REPEATS IS A LOG LINE, AND PEOPLE MUTE LOG LINES.
 *
 * These pin the three rules that make this a usable alarm rather than noise:
 * it fires once, it resolves itself, and it can never break the engine it is
 * warning about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const mod = await import('./engineAlerts.js');
const { raiseEngineAlert, resolveEngineAlert, firingFingerprints, __resetEngineAlerts } = mod;

const alert = {
  alertname: 'ClubArenaFleetSilent',
  severity: 'critical' as const,
  component: 'club-arena-engine',
  summary: 'zero hands',
};

beforeEach(() => {
  __resetEngineAlerts();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  process.env.ALERT_WEBHOOK_SECRET = 'test-secret';
});
afterEach(() => {
  delete process.env.ALERT_WEBHOOK_SECRET;
});

describe('raiseEngineAlert', () => {
  it('fires once, not once per polling cycle', async () => {
    await raiseEngineAlert(alert);
    await raiseEngineAlert(alert);
    await raiseEngineAlert(alert);
    expect(firingFingerprints()).toEqual(['ClubArenaFleetSilent:club-arena-engine']);
  });

  it('never throws when the receiver is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    // An alarm that breaks the thing it was warning about is worse than none.
    await expect(raiseEngineAlert(alert)).resolves.toBe(false);
  });

  it('never throws when the receiver rejects it', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(raiseEngineAlert(alert)).resolves.toBe(false);
  });
});

describe('resolveEngineAlert', () => {
  it('closes a firing alert so nobody has to notice it stopped', async () => {
    await raiseEngineAlert(alert);
    expect(firingFingerprints()).toHaveLength(1);
    await resolveEngineAlert(alert.alertname, alert.component);
    expect(firingFingerprints()).toEqual([]);
  });

  it('is a no-op when nothing is firing, so it is safe every cycle', async () => {
    await expect(resolveEngineAlert(alert.alertname, alert.component)).resolves.toBe(false);
  });

  it('lets the same alert fire again after it has resolved', async () => {
    await raiseEngineAlert(alert);
    await resolveEngineAlert(alert.alertname, alert.component);
    await raiseEngineAlert(alert);
    expect(firingFingerprints()).toHaveLength(1);
  });
});

describe('when it is not configured', () => {
  it('stays inert instead of failing, and does not post', async () => {
    delete process.env.ALERT_WEBHOOK_SECRET;
    __resetEngineAlerts();
    // Re-import so the module reads the cleared env at load time.
    vi.resetModules();
    const fresh = await import('./engineAlerts.js');
    fetchMock.mockClear();
    await expect(fresh.raiseEngineAlert({ ...alert, alertname: 'Unconfigured' })).resolves.toBe(
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * THE PAGE (Dan, 2026-09-11): a critical the caller marks `page: true` is
 * mirrored to the phones in `ca_incident_recipients` through the push path
 * that already delivers financial incidents. Same dedupe as the webhook; a
 * failing database never reaches the caller.
 */
describe('the page mirror', () => {
  const calls: Array<{
    userId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }> = [];
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    calls.length = 0;
    mod.__setEnginePageTransport({
      recipients: async () => ['dan-platform', 'ops-technical'],
      notify: async (userId, title, body, data) => {
        calls.push({ userId, title, body, data });
      },
    });
  });
  afterEach(() => mod.__setEnginePageTransport(null));

  it('pages every active platform recipient once for a paged critical', async () => {
    await raiseEngineAlert({ ...alert, page: true });
    await raiseEngineAlert({ ...alert, page: true });
    await flush();
    expect(calls.map((c) => c.userId)).toEqual(['dan-platform', 'ops-technical']);
    expect(calls[0].title).toBe('Horse Fleet Alert: ClubArenaFleetSilent');
    expect(calls[0].title).not.toContain(String.fromCharCode(0x2014));
    expect(calls[0].data).toMatchObject({
      alertname: 'ClubArenaFleetSilent',
      severity: 'critical',
    });
  });

  it('does not page a warning, nor a critical that did not ask', async () => {
    await raiseEngineAlert({ ...alert, alertname: 'Quiet', page: true, severity: 'warning' });
    await raiseEngineAlert({ ...alert, alertname: 'Email' });
    await flush();
    expect(calls).toEqual([]);
  });

  it('never lets the page break the raise', async () => {
    mod.__setEnginePageTransport({
      recipients: async () => {
        throw new Error('db down');
      },
      notify: async () => {},
    });
    /* The RETURN value belongs to the webhook (false with no
       ALERT_WEBHOOK_SECRET, which is the state of every test environment and
       of the engine until that secret is set). What this case is about is
       rule 1: the page cannot throw into the raise, and the alert is still
       recorded as firing. Both are asserted, neither is the webhook's. */
    await expect(raiseEngineAlert({ ...alert, page: true })).resolves.not.toThrow();
    await flush();
    expect(firingFingerprints()).toEqual(['ClubArenaFleetSilent:club-arena-engine']);
  });

  it('the two fleet-collapse criticals are the ones that page', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./DealRateVerifier.ts', import.meta.url)),
      'utf8'
    );
    for (const name of ['ClubArenaFleetFloorLost', 'ClubArenaFleetSilent']) {
      /* The raise CALL, bounded by its own parentheses
         (tests/unit/noFixedSizeSourceWindows): a byte window drifts off the
         end of the object the moment somebody documents a field. */
      const call = sliceEnclosingBlock(src, "alertname: '" + name + "'");
      expect(call, name + ' no longer raises an alert').toContain("alertname: '" + name + "'");
      expect(call, name + ' must ask for the page').toContain('page: true');
    }
  });
});
