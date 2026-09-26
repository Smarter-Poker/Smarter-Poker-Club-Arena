/**
 * A DETECTOR THAT LOOKS FOR A VALUE ITS TABLE CANNOT HOLD IS A DETECTOR THAT IS
 * SWITCHED OFF (2026-09-25).
 *
 * `public.fn_ca_escrow_ttl_sweep()`, installed by 20260831160515 and driven by
 * cron job `ca-escrow-ttl-sweep-10m` every ten minutes, scanned:
 *
 *     SELECT * FROM chip_escrow_holds
 *      WHERE status = 'active' AND expires_at IS NOT NULL
 *
 * `active` is not in `chip_escrow_holds_status_check` - the domain is
 * ('held','released','captured','expired'), the column defaults to 'held', and
 * every other reader of the table (fn_release_tournament_holds,
 * fn_remove_settled_club_member, fn_retire_settled_club) reads 'held'. Only the
 * watchdog looked for a value the table cannot hold, so its loop body never ran
 * once: 2,054 cron firings since 2026-09-11, every one `succeeded`, every one
 * over zero rows.
 *
 * What it did not see: 166 holds, status 'held', 3,778,600 chips, every
 * expires_at in 2026-08-16/17 - forty days stranded, 51 owners, 37 closed
 * tables, and no incident ever raised. `ca_ledger_accounts` carried the same
 * phantom: the escrow liability's backing read `chip_escrow_holds.amount
 * (active)`.
 *
 * THE RULE THIS PINS, in three parts:
 *
 *   1. The sweep reads the status the table enforces, and the migration that
 *      writes the literal ASSERTS the domain first, so a second wrong literal
 *      cannot be installed by a later "tidy-up".
 *   2. It stays an OBSERVER. It calls fn_ca_raise_drift_incident and returns a
 *      count. It does not release, credit, capture or expire a hold. CLAUDE.md
 *      10.12: a scheduled job may not become the thing that settles what a live
 *      path owes - and no debit backs these holds, so crediting them would be
 *      the double-payment, not the repair.
 *   3. The per-run bound stays. LIMIT 25, now ordered oldest-first so the batch
 *      is the same batch on replay, and every finding carries the whole
 *      backlog's count and total so the holds the bound leaves behind are
 *      visible without filing a row for each.
 *
 * The executable RED/GREEN proof against production's exact catalogue lives in
 * tests/fixtures/escrow-ttl-status-domain/ (see its README for the command and
 * the measured output). This file is the source contract that keeps it honest.
 *
 * Registry: docs/laws.d/the-escrow-ttl-sweep-reads-the-real-status-domain.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { migrationText, migrationsMentioning } from './helpers/migrationCorpus';

const NAME = '20260925130241_the_escrow_ttl_sweep_reads_the_real_status_domain.sql';
const FIXTURES = resolve(__dirname, 'fixtures', 'escrow-ttl-status-domain');
const fixture = (file: string) => readFileSync(resolve(FIXTURES, file), 'utf8');

describe('the escrow TTL sweep reads the real status domain', () => {
  /** The sweep's own body, between its CREATE and the REVOKE that follows it. */
  const sweepBody = () => {
    const sql = migrationText(NAME);
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()');
    const end = sql.indexOf('REVOKE ALL ON FUNCTION public.fn_ca_escrow_ttl_sweep()');
    expect(start, 'the migration must replace the sweep').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return sql.slice(start, end);
  };

  it('scans the status the table enforces, and never the phantom', () => {
    const body = sweepBody();
    expect(body).toContain("h.status = 'held'");
    // twice: the backlog count and the bounded loop must agree on the value
    expect(body.match(/h\.status = 'held'/g)).toHaveLength(2);
    // the phantom survives elsewhere in the file only as prose about the defect
    // and as the assertions that refuse it - never as a predicate the sweep runs
    expect(body).not.toContain("'active'");
  });

  it('asserts the status domain before it writes a literal into the sweep', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain('chip_escrow_holds_status_check');
    expect(sql).toContain(
      'failed: chip_escrow_holds_status_check is absent; the status domain is no longer enforced'
    );
    expect(sql).toContain(
      "failed: chip_escrow_holds_status_check now admits ''active''; re-measure before changing the sweep"
    );
    expect(sql).toContain("failed: chip_escrow_holds.status no longer defaults to ''held''");
    // the domain check runs BEFORE the replacement, not after it
    expect(sql.indexOf('chip_escrow_holds_status_check')).toBeLessThan(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()')
    );
  });

  it('keeps the per-run bound, and makes the bounded batch the same batch twice', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain('LIMIT 25');
    expect(sql).toContain('ORDER BY h.expires_at, h.id');
    expect(sql).toContain('failed: the sweep lost its per-run bound of 25');
    expect(sql).toContain(
      "failed: the sweep''s bounded batch is not ordered oldest-first, so it is not the same batch twice"
    );
  });

  it('reports the backlog the bound deliberately leaves behind', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain('expired_holds_total');
    expect(sql).toContain('expired_amount_total');
    expect(sql).toContain(
      'failed: a bounded batch that does not report the backlog it left behind hides it'
    );
  });

  it('stays an observer: no money door, and no schedule of its own', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain(
      'failed: the sweep acquired a write path; CLAUDE.md 10.12 forbids a scheduled job settling what a live path owes'
    );
    expect(sql).toContain('failed: the sweep body now schedules work of its own');
    // the sweep's own body updates and inserts nothing
    const body = sweepBody();
    expect(body).not.toMatch(/UPDATE\s+(public\.)?(wallets|chip_escrow_holds|club_members)/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+(public\.)?(wallet_transactions|chip_ledger)/i);
    expect(body).not.toMatch(/DELETE\s+FROM/i);
    expect(body).toContain('public.fn_ca_raise_drift_incident');
  });

  it('adds no cron, watcher or reconciler, and proves the schedule it repairs is the existing one', () => {
    const sql = migrationText(NAME);
    expect(sql).not.toMatch(/cron\.schedule\s*\(/);
    expect(sql).not.toMatch(/cron\.unschedule\s*\(/);
    expect(sql).toContain("jobname = 'ca-escrow-ttl-sweep-10m'");
    expect(sql).toContain(
      'failed: ca-escrow-ttl-sweep-10m is gone; the repaired sweep has no driver'
    );
    expect(sql).toContain('this migration must add and remove none');
  });

  it('settles nothing, and refuses to install if the measured population moved', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain('it must move no hold');
    expect(sql).toContain('re-measure and re-review the release question before installing');
    // and it proves RED -> GREEN on the catalogue it is applied to
    expect(sql).toContain(
      'failed: the phantom predicate matched % row(s); the premise of this repair is wrong'
    );
    expect(sql).toContain(
      'failed: the repaired predicate sees nothing, so this apply proves nothing'
    );
  });

  it('documents the escrow liability against a status the table can hold', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain("SET backing = 'chip_escrow_holds.amount (held)'");
    expect(sql).toContain("AND backing = 'chip_escrow_holds.amount (active)'");
    expect(sql).toContain('failed: the escrow liability is still backed by %');
    // nothing else in the corpus may reintroduce the phantom backing
    const offenders = migrationsMentioning("'chip_escrow_holds.amount (active)'")
      .map((m) => m.name)
      .filter((name) => name !== NAME);
    expect(offenders).toEqual(['20260831143501_ca_ledger_hardening.sql']);
  });

  it('proves the Sept 28 discovery cursors are not on this path', () => {
    const sql = migrationText(NAME);
    expect(sql).toContain("timestamptz '2026-09-21T07:00:00Z'");
    expect(sql).toContain('failed: the union discovery cursor moved');
    expect(sql).toContain('failed: the club discovery cursor moved');
  });

  it('retains an executable RED and GREEN against the installed preimage', () => {
    const overlay = fixture('overlay.sql');
    const seed = fixture('seed.sql');
    const red = fixture('red.sql');
    const green = fixture('regression.sql');

    // the overlay carries the DEFECT, byte-for-byte, or RED proves nothing
    expect(overlay).toContain("WHERE status = 'active' AND expires_at IS NOT NULL");
    expect(overlay).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()');
    expect(overlay).toContain('chip_escrow_holds_status_check');
    expect(overlay).toContain("'chip_escrow_holds.amount (active)'");
    expect(overlay).toContain("'ca-escrow-ttl-sweep-10m'");

    // the seed is production's measured population, not a convenient one
    expect(seed).toContain("expected production''s 166/539");
    expect(seed).toContain('expected 165');

    // RED: the installed predicate sees nothing over a table full of findings
    expect(red).toContain('RED FAIL: the installed sweep returned %');
    expect(red).toContain('RED FAIL: the installed sweep filed % incident(s)');

    // GREEN: every part of the rule, and a probe that rolls itself back
    expect(green).toContain('expected exactly its bound of 25');
    expect(green).toContain('the batch is not oldest-first');
    expect(green).toContain('do not report the standing backlog');
    expect(green).toContain("an out-of-scope club''s hold was filed");
    expect(green).toContain('a released, captured, expired or unexpired hold was reported');
    expect(green).toContain('a replay filed % incidents where the first pass filed %');
    expect(green).toContain('GREEN FAIL: the sweep changed chip_escrow_holds');
    expect(green).toContain('GREEN FAIL: the sweep moved chips into a wallet');
    expect(green).toContain('GREEN FAIL: the sweep wrote a money journal row');
    expect(green).toContain('GREEN FAIL: a weekly discovery cursor moved');
    expect(green.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });
});
