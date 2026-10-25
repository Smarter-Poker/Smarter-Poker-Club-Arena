/**
 * ===========================================================================
 *  LAW - NO LIVE DOOR HOLDS THE LEASE AGAINST ITS OWN HEARTBEAT
 * ===========================================================================
 *
 * Phase 1 of the lease follow-ups (2026-10-25). Three times in one day a
 * tournament manager lost its lease while the database still named it: its
 * own launch transaction held FOR UPDATE on the event's engine_tournament_leases
 * row, heartbeat_tournament_leases_v4 (FOR NO KEY UPDATE ... SKIP LOCKED)
 * answered `busy` for that row until the 20 s proof ran out, and the manager
 * fenced every table it owned - 41 at once at 13:27:10 UTC. The hand commit
 * had the same defect fixed on 2026-09-10, the two MTT launch doors on
 * 2026-10-25 (20261025200555), the Spin launch door the same evening
 * (20261025224305). Each time the correction was the same: FOR KEY SHARE,
 * which blocks a takeover (FOR UPDATE) and a release (DELETE) and nothing else.
 *
 * The rule, so there is no fourth time: a function that a LIVE manager calls
 * while it means to go on dealing never takes FOR UPDATE, FOR NO KEY UPDATE or
 * FOR SHARE on engine_tournament_leases. Only the doors that MOVE or END a
 * lease may: the takeover, the releases, the reaper, and the heartbeat's own
 * SKIP LOCKED pass. Two recovery doors are admitted by name with their reason
 * written beside them. Everything else written from this law's version on
 * takes FOR KEY SHARE or does not lock the row at all.
 *
 * The audit behind the allow-list (production pg_proc, 2026-10-25 22:30 UTC):
 * 24 functions lock the row; the engine calls 7 of them; of those, 3 were the
 * launch doors (fixed), 3 move or end the lease (allowed), 1 is the
 * resume-time abandoned-generation door whose FOR UPDATE is documented in its
 * own body as a deliberate barrier that runs before any dealer is built
 * (allowed by name), and fn_f06_prepare_mixed_manager_custody locks only a
 * row whose heartbeat is already stale (allowed by name). The remaining 12
 * have no caller on any live path and are historical one-off doors; they are
 * older than this law's cutoff and are not re-defined.
 *
 * Registry: docs/laws.d/no-live-door-holds-the-lease-against-its-own-heartbeat.md
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationText } from './helpers/migrationCorpus';

const FILE = '20261025224305_the_spin_draw_does_not_hold_the_lease_against_its_own_heartb.sql';
const CUTOFF = FILE.slice(0, 14);

/** Doors that move or end a lease, and must lock it. */
const MOVES_OR_ENDS_THE_LEASE = new Set([
  'claim_tournament_lease_v2',
  'release_tournament_leases',
  'release_tournament_leases_v2',
  'reap_dead_engine_leases',
  // FOR NO KEY UPDATE ... SKIP LOCKED: the renewal itself, never a holder.
  'heartbeat_tournament_leases_v4',
]);
/** Recovery doors admitted by name, each with the reason the audit found. */
const ADMITTED_BY_NAME = new Map<string, string>([
  [
    'fn_f06_abort_abandoned_generation',
    'its FOR UPDATE is a documented barrier that drains every protocol-2 request before the abort; it runs at resume, before any dealer is built',
  ],
  [
    'fn_f06_prepare_mixed_manager_custody',
    'it locks only a lease whose heartbeat is already stale (F06_MIXED_OLD_LEASE_CHANGED otherwise), so no live heartbeat is behind it',
  ],
]);

const HEAVY_LOCK =
  /engine_tournament_leases(?:\s+(?:AS\s+)?[a-z_]+)?\s[^;]*?FOR (?:UPDATE|NO KEY UPDATE|SHARE)\b(?!\s*OF\s+l\s+SKIP LOCKED)/i;

/** Every CREATE [OR REPLACE] FUNCTION in a migration: name and dollar-quoted body. */
function functionBodies(sql: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const heads =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:public|smarter_private)\.)?([a-z_0-9]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = heads.exec(sql)) !== null) {
    const rest = sql.slice(match.index);
    const open = rest.match(/\$([A-Za-z_]*)\$/);
    if (!open) continue;
    const tag = open[0];
    const start = rest.indexOf(tag) + tag.length;
    const end = rest.indexOf(tag, start);
    out.push({
      name: match[1].toLowerCase(),
      body: end === -1 ? rest.slice(start) : rest.slice(start, end),
    });
  }
  return out;
}

/** Migrations that edit a function in place by anchor (EXECUTE replace(...)) carry the clause as a string. */
function anchorEdits(sql: string): string[] {
  const edits: string[] = [];
  const re = /\|\|\s*E'([^']*(?:''[^']*)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) edits.push(m[1]);
  return edits;
}

describe('no live door holds the lease against its own heartbeat', () => {
  it('the Spin draw door is rewritten to FOR KEY SHARE by exact anchor, in one transaction, with its post-conditions', () => {
    const sql = migrationText(FILE);
    expect(sql).toContain(
      "v_anchor text := E'  SELECT * INTO v_lease FROM public.engine_tournament_leases\\n'"
    );
    expect(sql).toContain("|| E'   WHERE tournament_id = p_tournament_id FOR UPDATE;'");
    expect(sql).toContain('THE SPIN DRAW DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT');
    expect(sql).toContain("|| E'   FOR KEY SHARE;'");
    expect(sql).toMatch(
      /IF v_n <> 1 THEN\s*RAISE EXCEPTION 'spin draw lease anchor appears % times/
    );
    expect(sql).toContain('still takes FOR UPDATE on engine_tournament_leases');
    expect(sql).toContain('(UPDATE|DELETE FROM)\\s+public\\.engine_tournament_leases');
    expect(sql).toContain(
      "'fn_begin_tournament_launch_atomic', 'fn_complete_tournament_launch_atomic', 'fn_spin_draw_and_settle_atomic'"
    );
    expect(sql).toContain('FOR KEY SHARE would fence nothing');
    expect(sql).toContain("'FOR NO KEY UPDATE OF l SKIP LOCKED'");
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('DO $body$'));
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('after this law, no migration defines or edits a function that takes a heavy lock on the lease row unless it moves or ends the lease', () => {
    const later = migrationCorpus().filter((m) => m.name.slice(0, 14) > CUTOFF);
    const offenders: string[] = [];
    for (const m of later) {
      for (const fn of functionBodies(m.sql)) {
        if (MOVES_OR_ENDS_THE_LEASE.has(fn.name) || ADMITTED_BY_NAME.has(fn.name)) continue;
        if (HEAVY_LOCK.test(fn.body)) offenders.push(`${m.name} :: ${fn.name}`);
      }
      // An in-place anchor edit that INTRODUCES the heavy clause is the same offence.
      for (const edit of anchorEdits(m.sql)) {
        if (
          /^\s*FOR (?:UPDATE|NO KEY UPDATE|SHARE);/i.test(edit) &&
          /engine_tournament_leases/.test(m.sql)
        ) {
          offenders.push(`${m.name} :: anchor edit introduces "${edit.trim()}"`);
        }
      }
    }
    expect(
      offenders,
      'a function a live manager calls must lock engine_tournament_leases FOR KEY SHARE (or not at all): ' +
        'FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE makes the heartbeat answer busy for the life of the ' +
        'transaction and the manager fences every table it owns when its 20 s proof runs out. ' +
        'Only a door that moves or ends the lease may take it (see MOVES_OR_ENDS_THE_LEASE); a recovery ' +
        'door needs its reason written into ADMITTED_BY_NAME in this law'
    ).toEqual([]);
  });

  it('every admitted door carries a written reason, and the takeover and heartbeat still lock the way the rule assumes', () => {
    for (const [name, reason] of ADMITTED_BY_NAME) {
      expect(name.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(40);
    }
    const claim = migrationCorpus()
      .filter((m) =>
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.claim_tournament_lease_v2\s*\(/.test(m.sql)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(claim.length).toBeGreaterThan(0);
    expect(
      functionBodies(claim[claim.length - 1].sql).find(
        (f) => f.name === 'claim_tournament_lease_v2'
      )?.body
    ).toMatch(/engine_tournament_leases l\s[^;]*FOR UPDATE;/);
    const heartbeat = migrationCorpus()
      .filter((m) =>
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.heartbeat_tournament_leases_v4\s*\(/.test(
          m.sql
        )
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(heartbeat[heartbeat.length - 1].sql).toContain('FOR NO KEY UPDATE OF l SKIP LOCKED');
  });

  it('keeps its native two-session PostgreSQL proof in CI', () => {
    const workflow = readFileSync(
      '.github/workflows/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.yml',
      'utf8'
    );
    expect(workflow).toContain('python3 scripts/ci/test-spin-draw-lease-key-share-postgres.py');
    expect(workflow).toContain(`supabase/migrations/${FILE}`);
    expect(workflow).toContain('scripts/qualification/fixtures/spin-draw-lease-key-share/**');
    const proof = readFileSync('scripts/ci/test-spin-draw-lease-key-share-postgres.py', 'utf8');
    expect(proof).toContain("assert state == 'busy'");
    expect(proof).toContain("assert state == 'kept'");
    expect(proof).toContain('the takeover was not blocked by a draw in flight');
  });
});
