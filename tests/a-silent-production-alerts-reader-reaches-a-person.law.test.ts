/**
 * LAW: A SILENT PRODUCTION ALERTS READER REACHES A PERSON (2026-10-03).
 *
 * The owner's critical alerts (financial incidents, guarantee shortfalls,
 * failed engine breaks) are routed into the Production Alerts inbox and not
 * to his phone. The inbox has one reader. On 2026-10-03 nothing had been read
 * since 2026-10-01 20:02 UTC. Eight owner alerts had waited unread since then,
 * among them a KILL SWITCH at -100,005.30, and nothing told anyone.
 *
 * The routing is unchanged. What this pins:
 *   1. "read" is a column: a reader's investigation write stamps
 *      investigation_touched_at.
 *   2. A critical owner alert arriving after 12 hours of silence pages the
 *      owner ONCE per silence, with a title that is not an owner-operational
 *      type, so it can never be routed back into the unread inbox.
 *   3. Before the first stamp exists, the last read is the measured
 *      2026-10-01 20:02:05, never "now".
 *   4. The page can never fail the capture of the alert itself.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003102610_a_silent_production_alerts_reader_reaches_a_person.sql'
  ),
  'utf8'
);
const code = MIG.replace(/--[^\n]*/g, ' ');

describe('a silent Production Alerts reader reaches a person', () => {
  it('is one transaction with a live proof and named refusals', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIG).toMatch(/^-- @live-proof: \(SELECT EXISTS/m);
    for (const c of ['PREIMAGE_CHANGED', 'PAGE_WOULD_BE_DIVERTED', 'RESULT_CHANGED'])
      expect(MIG).toContain('READER_SILENCE_' + c);
  });

  it('stamps a read where a reader writes, and only when something changed', () => {
    expect(code).toContain(
      'ALTER TABLE public.operational_alert_events ADD COLUMN investigation_touched_at timestamptz;'
    );
    expect(code).toMatch(
      /BEFORE UPDATE OF investigation, investigation_status ON public\.operational_alert_events\s+FOR EACH ROW\s+WHEN \(OLD\.investigation IS DISTINCT FROM NEW\.investigation\s+OR OLD\.investigation_status IS DISTINCT FROM NEW\.investigation_status\)/
    );
    expect(code).toContain('NEW.investigation_touched_at := clock_timestamp();');
  });

  it('pages only critical owner alerts, after 12 hours of silence, once per silence', () => {
    expect(code).toMatch(
      /AFTER INSERT ON public\.operational_notification_destinations\s+FOR EACH ROW\s+WHEN \(\(NEW\.original_notification->>'type'\) IN \('financial_incident', 'guarantee_bank_short', 'engine_break_failed'\)\)/
    );
    expect(code).toContain("c_silence CONSTANT interval := interval '12 hours';");
    expect(code).toContain('IF v_last > now() - c_silence THEN');
    expect(code).toMatch(
      /AND n\.type = 'system'\s+AND n\.title = c_title\s+AND n\.created_at > v_last\) THEN\s+RETURN NULL;/
    );
  });

  it('never treats an unread inbox as freshly read', () => {
    expect(code).toContain(
      "c_measured_last_read CONSTANT timestamptz := '2026-10-01 20:02:05+00';"
    );
    expect(code).toContain('GREATEST(c_measured_last_read, max(e.investigation_touched_at))');
    expect(code).toContain('v_last := COALESCE(v_last, c_measured_last_read);');
  });

  it('cannot be routed back into the inbox it reports on, and cannot fail the capture', () => {
    expect(code).toContain("c_title CONSTANT text := 'Production Alerts Has Stopped Reading';");
    expect(code).toMatch(/READER_SILENCE_PAGE_WOULD_BE_DIVERTED/);
    expect(code).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'fn_ca_owner_route_reader_silence failed/
    );
    // Title Case, no em dash (CLAUDE.md 5.7 and 10.7).
    expect(MIG).not.toContain('—');
  });

  it('adds no schedule and is closed to browsers', () => {
    expect(code).not.toMatch(/cron\.(schedule|alter_job|unschedule)/);
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_owner_route_reader_silence() FROM PUBLIC, anon, authenticated;'
    );
  });
});
