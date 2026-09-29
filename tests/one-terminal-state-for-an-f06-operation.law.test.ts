/**
 * LAW: an F06 table break has ONE definition of finished.
 * ═══════════════════════════════════════════════════════════════════════════
 * Two things in the database answered "is this break finished?" and they did
 * not agree:
 *
 *   public.fn_f06_discover_breaks  state NOT IN ('acknowledged',
 *                                                'withdrawn_before_manifest')
 *   smarter_private.f06_lease_has_pending_custody   state <> 'acknowledged'
 *
 * Discovery is the protocol - it is what the engine drives the break state
 * machine from - and on 2026-09-21 it was ALSO the only spelling left in the
 * live database: every other F06 function, and the `f06_one_source` partial
 * unique index, already used the two-name set. The custody helper, added five
 * days earlier in 20260919024039, was the single outlier in the whole
 * protocol, and it held a dead engine lease for 30 events that nothing could
 * ever release. Waiting could not clear it and #5035 deliberately makes more
 * withdrawn_before_manifest rows.
 *
 * withdrawn_before_manifest IS terminal, and the proof is the protocol's own
 * constraints rather than anybody's say-so:
 *
 *   f06_withdrawal_receipt  (state = 'withdrawn_before_manifest')
 *                             = (abort_receipt_id IS NOT NULL)
 *   f06_operations_check    (state IN ('close_confirmed','acknowledged'))
 *                             = (close_receipt IS NOT NULL)
 *
 * The state cannot exist without a durable abort receipt and can never have
 * closed; no manifest was written, so no member was enrolled and no attempt
 * was made. All 31 production rows carry zero f06_attempts and zero
 * f06_members, and an f06_attempts row IS the player movement. Nothing is
 * half-moved behind one.
 *
 * CLAUDE.md 10.8: a disagreement between two written rules is not settled by
 * writing a third. The protocol's set is adopted verbatim and named ONCE, in
 * smarter_private.f06_terminal_operation_states(). This law keeps every later
 * restatement in step with it and refuses the old spelling's return.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const PROBES = join(ROOT, 'scripts', 'ci', 'probes', 'f06-shared-hand-lane');

/** The migration that deleted the divergence. */
const RECONCILIATION = '20260921165904_one_terminal_state_for_an_f06_operation.sql';
/** The migration that introduced it; everything strictly newer is new work. */
const DIVERGED_AT = '20260919024039';

const reconciliation = readFileSync(join(MIGRATIONS, RECONCILIATION), 'utf8');

/** SQL line comments are prose. They quote the old spelling on purpose. */
const withoutComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

const migrationFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));

describe('one terminal state for an F06 operation', () => {
  it('names the terminal set exactly once, and it is the protocol set', () => {
    const declarations = migrationFiles.filter((name) =>
      /CREATE (OR REPLACE )?FUNCTION smarter_private\.f06_terminal_operation_states/.test(
        readFileSync(join(MIGRATIONS, name), 'utf8')
      )
    );
    expect(declarations).toEqual([RECONCILIATION]);
    expect(reconciliation).toContain(
      "SELECT ARRAY['acknowledged', 'withdrawn_before_manifest']::text[]"
    );
  });

  it('keeps every state that still holds a lease OUT of the terminal set', () => {
    const body = reconciliation.slice(
      reconciliation.indexOf('CREATE FUNCTION smarter_private.f06_terminal_operation_states'),
      reconciliation.indexOf('REVOKE ALL ON FUNCTION smarter_private.f06_terminal_operation_states')
    );
    // The five states of f06_operations_state_check. Only two are finished.
    for (const open of ['park_requested', 'begun', 'close_confirmed']) {
      expect(body).not.toContain(open);
    }
    // and the migration asserts the state machine still has exactly those five
    expect(reconciliation).toContain('F06_OPERATION_STATE_MACHINE_CHANGED');
  });

  it('the custody predicate asks that one definition and carries no second one', () => {
    const custody = withoutComments(
      reconciliation.slice(
        reconciliation.indexOf(
          'CREATE OR REPLACE FUNCTION smarter_private.f06_lease_has_pending_custody'
        )
      )
    );
    expect(custody).toContain('smarter_private.f06_terminal_operation_states()');
    expect(custody).not.toMatch(/state\s*<>\s*'acknowledged'/);
    // an unclassifiable state keeps the lease - CLAUDE.md 10.86 rule 1
    expect(custody).toContain('COALESCE(NOT(o.state=ANY(');
    expect(custody).toContain(',true)');
  });

  it('does not widen the two custody tests that are not about operations', () => {
    const custody = reconciliation.slice(
      reconciliation.indexOf(
        'CREATE OR REPLACE FUNCTION smarter_private.f06_lease_has_pending_custody'
      )
    );
    // a hand permit still reserved holds the lease on its own
    expect(custody).toContain("f06_hand_permits h WHERE h.state='reserved'");
    // so does a manager custody transfer with no completion row
    expect(custody).toContain('f06_manager_custody_transfers');
    expect(custody).toContain(
      'f06_manager_custody_completions c WHERE c.transfer_id=t.transfer_id'
    );
  });

  it('proves withdrawn_before_manifest really is empty before it believes it', () => {
    // The load-bearing assertion: no attempt and no member behind a withdrawal,
    // so no seated stack is mid-move. The migration refuses if that is untrue.
    expect(reconciliation).toContain('F06_WITHDRAWN_OPERATION_IS_NOT_EMPTY');
    expect(reconciliation).toContain(
      'FROM smarter_private.f06_attempts a WHERE a.break_id = o.break_id'
    );
    expect(reconciliation).toContain(
      'FROM smarter_private.f06_members m WHERE m.break_id = o.break_id'
    );
    // and "before manifest" is now enforced by the schema, not just the name
    expect(reconciliation).toContain('CONSTRAINT f06_withdrawal_has_no_manifest');
  });

  it('refuses the old spelling in any migration written after the divergence', () => {
    const offenders = migrationFiles
      .filter((name) => name.slice(0, 14) > DIVERGED_AT)
      .filter((name) =>
        /state\s*<>\s*'acknowledged'/.test(
          withoutComments(readFileSync(join(MIGRATIONS, name), 'utf8'))
        )
      );
    expect(offenders).toEqual([]);
  });

  it('every F06 authority that states the set states the whole set', () => {
    const files = readdirSync(PROBES).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const partial: string[] = [];
    let scanned = 0;
    for (const name of files) {
      const sql = readFileSync(join(PROBES, name), 'utf8');
      // A projection that predates the state entirely is modelling an earlier
      // protocol (fixture.sql's f06_operations has three columns and no
      // withdrawal at all; unsettled-schema.sql is what adds the state). The
      // rule is: if a file KNOWS the state exists, it must classify it.
      if (!sql.includes('withdrawn_before_manifest')) continue;
      scanned += 1;
      for (const match of sql.matchAll(/state\s*(?:NOT\s+)?IN\s*\(\s*'acknowledged'[^)]*\)/g)) {
        if (!match[0].includes('withdrawn_before_manifest')) partial.push(`${name}: ${match[0]}`);
      }
      if (/state\s*<>\s*'acknowledged'/.test(withoutComments(sql))) partial.push(`${name}: <>`);
    }
    expect(partial).toEqual([]);
    expect(scanned).toBeGreaterThan(0);
  });
});
