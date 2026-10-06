import { describe, expect, it } from 'vitest';
import { createCashierDiagnostics } from '../e2e/support/cashierFailureDiagnostics';

describe('Cashier failure diagnostics', () => {
  it('removes URL credentials, query and fragment and rejects arbitrary error text', () => {
    const log = createCashierDiagnostics(() => 10);
    log.record(
      'requestfailed',
      'https://user:secret@example.com/rest/v1/profiles?token=secret#secret',
      'GET',
      'secret error'
    );
    expect(log.snapshot().events).toEqual([
      {
        kind: 'requestfailed',
        ms: 0,
        origin: 'https://example.com',
        path: '/rest/v1/profiles',
        method: 'GET',
        code: 'NETWORK_FAILURE',
      },
    ]);
    expect(JSON.stringify(log.snapshot())).not.toContain('secret');
    log.record('navigation', 'data:text/plain,secret');
    log.record('navigation', 'invalid secret');
    expect(log.snapshot().events).toHaveLength(1);
  });
  it('keeps only the recent bounded events, fixed codes and valid HTTP error statuses', () => {
    let clock = 100;
    const log = createCashierDiagnostics(() => clock);
    for (let i = 0; i < 70; i++) {
      clock++;
      log.record('requestfailed', `https://example.com/${i}`, 'GET', 'net::ERR_ABORTED');
    }
    const snapshot = log.snapshot();
    expect(snapshot.dropped).toBe(6);
    expect(snapshot.events).toHaveLength(64);
    expect(snapshot.events[0]).toMatchObject({ path: '/6', ms: 7, code: 'net::ERR_ABORTED' });
    snapshot.events[0].path = 'mutated';
    expect(log.snapshot().events[0].path).toBe('/6');
    log.record('http-error', 'https://example.com/' + 'a'.repeat(1000), 'SECRET', 503);
    expect(log.snapshot().events.at(-1)).toMatchObject({ status: 503, method: '' });
    expect(log.snapshot().events.at(-1)?.path).toHaveLength(256);
    const before = log.snapshot();
    for (const code of [200, 600, NaN, 401.5])
      log.record('http-error', 'https://example.com', 'GET', code);
    expect(log.snapshot()).toEqual(before);
  });
});
