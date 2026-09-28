/**
 * A TERMINAL CLOSE MARKER MAY STAMP UNREGISTRATION EVIDENCE (2026-09-28)
 *
 * c7f21a83 "Sunday Funday Six-Card Closer" was decided at 01:10 UTC and its
 * winner could never be paid. Every finish attempt reached the last statement
 * of the terminal door, where fn_stamp_tournament_terminal_evidence_markers
 * stamps terminal_closed_at on every rake_records row of the event, and was
 * refused by fn_ca_unregistration_rake_evidence_is_immutable: the event held
 * one unregistration receipt naming a fee source and its reversal, and that
 * guard refused EVERY update of a named row, the close marker included. The
 * stamp raises if any row is left unstamped, so the two rules together meant
 * an event with an unregistration fee reversal could never complete or cancel.
 *
 * The sibling guard on the same rows (fn_satellite_target_rake_is_immutable)
 * already admits exactly the marker transition through
 * fn_ca_terminal_marker_transition_is_exact. This law pins that the
 * unregistration guard admits that one transition and nothing else, and that
 * the stamp it has to accept still stamps rake_records.
 *
 * docs/changelog/2026-09-28-a-terminal-close-marker-may-stamp-unregistration-evidence.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20260928163959_a_terminal_close_marker_may_stamp_unregistration_rake_eviden.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20260909165629_satellite_settlement_has_one_atomic_authority.sql'),
  'utf8'
);

const TAG = '$unregistration_rake_evidence_is_immutable$';
const PRE_MD5 = '9a1109d19453657645e668d6e0310113';
const POST_MD5 = '05c68d8a7a9e0364483cee945695e020';
const HELPER = 'public.fn_ca_terminal_marker_transition_is_exact(';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()'
  );
  expect(start, 'the file defines the unregistration evidence guard').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(TAG, start) + TAG.length;
  const close = sql.indexOf(TAG, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const NEW_BODY = body(SQL);
const OLD_BODY = body(ORIGIN);

describe('a terminal close marker may stamp unregistration rake evidence', () => {
  it('replaces exactly the body production held, and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('admits the close marker before it looks for a receipt, and only through the exact-transition helper', () => {
    const early = NEW_BODY.indexOf(HELPER);
    const receipt = NEW_BODY.indexOf('tournament_unregistration_receipts');
    expect(early, 'the guard asks the shared exact-transition helper').toBeGreaterThan(0);
    expect(receipt).toBeGreaterThan(early);
    const gate = NEW_BODY.slice(NEW_BODY.indexOf("IF TG_OP = 'UPDATE'"), receipt);
    expect(gate).toContain('NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at');
    expect(gate).toContain('to_jsonb(OLD), to_jsonb(NEW), OLD.tournament_id');
    expect(gate).toContain('RETURN NEW;');
    // No other way past the refusal: a DELETE, or any UPDATE the helper does
    // not call exact, still reaches the receipt check and its RAISE.
    expect(gate).not.toMatch(/RETURN OLD/);
    expect(NEW_BODY.match(/RETURN NEW;/g)?.length).toBe(1);
  });

  it('keeps the refusal, its message and its SQLSTATE exactly', () => {
    const tail = (b: string) => b.slice(b.indexOf('  IF EXISTS ('));
    expect(tail(NEW_BODY)).toBe(tail(OLD_BODY));
    expect(NEW_BODY).toContain("'committed tournament unregistration rake evidence is immutable'");
    expect(NEW_BODY).toContain("USING ERRCODE='55000'");
  });

  it('is the same transition every sibling rake guard admits', () => {
    const sibling = readFileSync(
      join(
        MIGRATIONS,
        '20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
      ),
      'utf8'
    );
    const at = sibling.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_satellite_target_rake_is_immutable()'
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const next = sibling.indexOf('CREATE OR REPLACE FUNCTION', at + 10);
    const sib = sibling.slice(at, next > at ? next : undefined);
    expect(sib).toContain('fn_ca_terminal_marker_transition_is_exact(');
    // And the migration refuses to reuse a helper whose body has drifted.
    expect(SQL).toContain("md5(p.prosrc) = '3c9ce32b45c11b7372654c6efa89f667'");
  });

  it('does not touch the trigger, and keeps owner, ACL, security and search_path', () => {
    expect(SQL).not.toMatch(/DROP\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+(CONSTRAINT\s+)?TRIGGER/i);
    expect(SQL).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public'/);
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres}'");
    expect(SQL).toContain('t.tgtype = 27');
    expect(SQL).not.toMatch(/GRANT\s/i);
  });

  it('is one transaction that writes no row', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout/);
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
    expect(code).not.toMatch(/cron\./i);
  });

  it('is the newest definition of the guard in the repository', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()'
        )
      );
    expect(later).toEqual([]);
  });
});
