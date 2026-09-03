/**
 * AN ALERT THAT REPEATS IS A LOG LINE, AND PEOPLE MUTE LOG LINES.
 *
 * These pin the three rules that make this a usable alarm rather than noise:
 * it fires once, it resolves itself, and it can never break the engine it is
 * warning about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
