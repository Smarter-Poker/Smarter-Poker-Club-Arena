/**
 * LAW: THE OPERATIONAL ALERT CLOSES WHEN ITS UPSTREAM RESOLVES (2026-10-06).
 *
 * public.operational_alert_events had no closure path at all:
 * investigation_touched_at was NULL on all 209,580 rows, so no row had ever
 * been transitioned by anything, while the mirror minted a new OPEN row for
 * every snapshot - including the recovery. 91,999 of 116,777 open rows (78.8
 * pct) carried status='resolved', and the backlog had risen forty-one
 * consecutive times because nothing could ever leave it.
 *
 * What this pins: the close happens in the upstream resolution's own
 * transaction and adds no watcher; it fires only on LIVE upstream evidence read
 * in the same statement; it closes to 'historical' and never claims
 * verified_fixed; it is exactly reversible because every row records the status
 * it came from; a closure failure can never abort the upstream money result;
 * and the migration writes no table but the alert store.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261006052925_the_operational_alert_closes_when_its_upstream_resolves';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE + '.sql'), 'utf8');
/** The executable statements only. Prose explains what the migration does and
 *  names tables and operations in sentences; a claim about what it WRITES has
 *  to read the SQL, not the commentary around it. */
const SQL = MIG.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('the operational alert closes when its upstream resolves', () => {
  it('is one transaction, refuses in the break window, and proves itself live', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain('public.fn_ca_break_window_refuses_migrations(now())');
    expect(MIG).toContain('ALERT_CLOSURE_REFUSED');
    expect(MIG).toContain(
      `-- @live-proof: (SELECT count(*) FROM public.operational_alert_events WHERE investigation_status = 'historical' AND investigation->>'closed_by' = '${FILE}') > 0`
    );
  });

  it('closes ONLY on live upstream evidence, never on the row its own payload carries', () => {
    // The upstream CTE reads the authoritative tables, not payload snapshots.
    expect(MIG).toMatch(
      /FROM public\.financial_alerts a\s+WHERE p_kind = 'financial'\s+AND a\.resolved IS TRUE/
    );
    expect(MIG).toMatch(
      /FROM public\.ca_drift_incidents d\s+WHERE p_kind = 'drift'\s+AND d\.resolved_at IS NOT NULL/
    );
    // It must never decide resolution from the stored snapshot.
    expect(MIG).not.toMatch(/original_event'->>'resolved'/);
    expect(MIG).not.toMatch(/original_incident'->>'resolved_at'/);
  });

  it('closes to historical and never claims a root-cause repair', () => {
    expect(MIG).toContain("SET investigation_status = 'historical',");
    expect(MIG).not.toMatch(/investigation_status\s*=\s*'verified_fixed'/);
    expect(MIG).not.toMatch(/SET\s+investigation_status\s*=\s*'blocked'/);
  });

  it('is exactly reversible: every closed row records where it came from', () => {
    expect(MIG).toContain("'closed_from', e.investigation_status");
    expect(MIG).toContain("'upstream_id', u.uid::text");
    expect(MIG).toContain("'upstream_resolved_at', u.resolved_at");
    // and the rollback restores from exactly that field
    expect(MIG).toContain("SET investigation_status = investigation->>'closed_from'");
    expect(MIG).toMatch(
      /-- ROLLBACK: *DROP INDEX IF EXISTS public\.operational_alert_events_open_upstream_key_idx;/
    );
    expect(MIG).toMatch(
      /-- ROLLBACK: *DROP FUNCTION IF EXISTS public\.fn_close_operational_alerts_for_upstream\(text, text\);/
    );
  });

  it('asserts its own soundness three ways instead of trusting a frozen count', () => {
    expect(MIG).toContain('closure incomplete: % rows whose upstream is resolved are still open');
    expect(MIG).toContain('closure unsound: % rows closed without a resolved upstream');
    expect(MIG).toContain(
      'closure not reversible: % rows lack closed_from, upstream_id or a touch time'
    );
  });

  it('one implementation serves the trigger and the backfill, so the predicate cannot drift', () => {
    expect(MIG).toContain('p_kind text, p_source_id text DEFAULT NULL');
    // the backfill calls the same function with no id
    expect(MIG).toContain("public.fn_close_operational_alerts_for_upstream('financial')");
    expect(MIG).toContain("public.fn_close_operational_alerts_for_upstream('drift')");
    // and the trigger calls it with one id
    expect(MIG).toContain(
      "PERFORM public.fn_close_operational_alerts_for_upstream(k, (to_jsonb(NEW)->>'id'));"
    );
    // an identity that is not a uuid is refused
    expect(MIG).toContain('operational closure identity is invalid');
  });

  it('adds no watcher and keeps the existing trigger binding guard', () => {
    expect(MIG).not.toMatch(/\b(pg_cron|cron\.schedule|pg_background|LISTEN|NOTIFY)\b/i);
    expect(MIG).toContain("RAISE EXCEPTION 'invalid operational source trigger binding'");
    expect(MIG).toContain("TG_OP NOT IN ('INSERT','UPDATE')");
    // it closes only on the transition into resolved, not on every update
    expect(MIG).toContain('IF v_resolved_now AND NOT v_resolved_before THEN');
  });

  it('can never abort the upstream money or incident result', () => {
    expect(MIG).toContain(
      "RAISE WARNING 'operational alert closure failed kind=% id=% SQLSTATE=%: %'"
    );
    // the closure is wrapped, so its failure warns and the upstream UPDATE stands
    expect(MIG).toMatch(
      /BEGIN\s+PERFORM public\.fn_close_operational_alerts_for_upstream\(k, \(to_jsonb\(NEW\)->>'id'\)\);\s+EXCEPTION WHEN OTHERS THEN/
    );
  });

  it('writes no table but the alert store, and moves no money', () => {
    const writes = [
      ...SQL.matchAll(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?([a-z_]+)/gi),
    ].map((m) => m[1].toLowerCase());
    expect(new Set(writes)).toEqual(new Set(['operational_alert_events']));
    // Against SQL, not prose: the header deliberately NAMES these tables to
    // promise it touches none of them.
    expect(SQL).not.toMatch(
      /\b(chip_ledger|chip_treasury|wallet_transactions|club_members|rake_records|payouts?)\b/
    );
    expect(SQL).not.toMatch(/fn_credit|fn_settle|fn_debit/);
    expect(MIG).not.toContain('—');
  });

  it('says plainly what it does not do', () => {
    expect(MIG).toContain("'historical' is not 'verified_fixed'");
    expect(MIG).toMatch(
      /SCOPE\. financial and drift only\. The engine kind is deliberately excluded/
    );
    expect(MIG).toMatch(/A RECURRENCE IS NOT HIDDEN/);
  });
});
