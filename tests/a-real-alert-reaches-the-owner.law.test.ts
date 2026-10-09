/**
 * LAW: A REAL ALERT REACHES THE STORE, NOT THE OWNER (2026-10-09).
 *
 * Operational alerts must never reach the owner's phone (push or SMS) or personal feed.
 * Outages, engine restarts, money or ledger integrity failures, monitor firings
 * and recoveries go to the alert store (public.operational_alert_events) via
 * public.fn_record_operational_alert.
 *
 * This test asserts the opposite of the former behaviour: a firing row of each kind
 * creates no notification and no push.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

describe('a real alert reaches the store, not the owner', () => {
  it('does not have active triggers for paging the owner', () => {
    let alertReachesOwnerActive = false;
    let readerSilenceActive = false;

    for (const { sql } of migrationCorpus()) {
      // Check for trigger creation
      if (sql.match(/CREATE\s+TRIGGER\s+zz_a_real_alert_reaches_the_owner/)) {
        alertReachesOwnerActive = true;
      }
      if (sql.match(/CREATE\s+TRIGGER\s+zz_owner_route_reader_silence/)) {
        readerSilenceActive = true;
      }

      // Check for trigger dropping
      if (sql.match(/DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?zz_a_real_alert_reaches_the_owner/)) {
        alertReachesOwnerActive = false;
      }
      if (sql.match(/DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?zz_owner_route_reader_silence/)) {
        readerSilenceActive = false;
      }
    }

    expect(alertReachesOwnerActive).toBe(false);
    expect(readerSilenceActive).toBe(false);
  });
});
