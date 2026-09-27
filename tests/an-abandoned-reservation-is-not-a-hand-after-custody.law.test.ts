/**
 * AN ABANDONED RESERVATION IS NOT A HAND AFTER CUSTODY (2026-09-27)
 *
 * fn_park_stopped_time_bank_custody is the only door through which a terminal
 * tournament engine writes the time banks it froze at its stop. Until that
 * write is confirmed the engine reports stopped_bank_custody_unwritten, then
 * stopped_bank_custody_stuck, and both refuse the restart certificate by
 * design: no bank or custody reason may enter the release allow-list.
 *
 * The door refused hand_after_custody for any F06 permit above the custody's
 * hand that was not 'never_started'. A tournament engine reserves its NEXT
 * hand under the rest, before it deals; when the manager's lease is lost in
 * that gap the hand never starts, handCount goes back to the last completed
 * hand, and the cancellation of the reservation is fenced because the lease
 * that would authorise it is gone. The permit stays 'reserved' and the door
 * refused the custody for ever. Six tables held the certificate shut for 26
 * consecutive breaks on 2026-09-26/27 in exactly this state; a rolled-back
 * probe returned hand_after_custody / f06_hand_permits for all six.
 *
 * The rule: a 'reserved' permit of the CALLER's tournament and generation no
 * longer counts as a hand after custody. Everything else still refuses: a
 * hand_history, hand_atomic_commits or hand_state_snapshots row after the
 * custody, a permit of any other generation or tournament, a null generation,
 * an 'accepted' or 'aborted_unsettled' permit. These laws read the LATEST
 * migration that defines the function, so a later redefinition is held to the
 * same rules, and each rule has a planted regression the same check refuses.
 *
 * 20260927144106. docs/changelog/2026-09-27-an-abandoned-reservation-is-not-a-hand-after-custody.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE_NAME = '20260927144106_an_abandoned_reservation_is_not_a_hand_after_custody.sql';

function bodyOf(sql: string): string | null {
  const m = sql.match(
    /CREATE (?:OR REPLACE )?FUNCTION public\.fn_park_stopped_time_bank_custody\([\s\S]*?AS (\$[a-z_]*\$)([\s\S]*?)\1;/
  );
  return m ? m[2] : null;
}

function latestDefinition(): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const body = bodyOf(readFileSync(join(MIGRATIONS, file), 'utf8'));
    if (body) found = { file, body };
  }
  if (!found) throw new Error('no migration defines public.fn_park_stopped_time_bank_custody');
  return found;
}

/** Comments out, whitespace collapsed: the rules are about code, not prose. */
const code = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ');

/** The permit clause of the function, the only statement that reads f06_hand_permits. */
function permitClause(c: string): string | null {
  const at = c.indexOf('FROM smarter_private.f06_hand_permits h');
  if (at < 0) return null;
  const end = c.indexOf('END IF;', at);
  return end < 0 ? null : c.slice(at, end);
}

/** Every violation of the rules, empty when the body keeps them. */
function violations(raw: string): string[] {
  const c = code(raw);
  const out: string[] = [];
  for (const evidence of ['hand_history', 'hand_atomic_commits', 'hand_state_snapshots']) {
    const clause = new RegExp(
      `IF EXISTS \\(SELECT 1 FROM public\\.${evidence} h WHERE h\\.table_id = p_table_id AND h\\.hand_number > p_hand_number\\) THEN RETURN jsonb_build_object\\('ok', false, 'refused', 'hand_after_custody'`
    );
    if (!clause.test(c)) out.push(`a recorded ${evidence} row after the custody no longer refuses`);
  }
  const permit = permitClause(c);
  if (!permit) return [...out, 'the f06_hand_permits clause is missing'];
  if (!permit.includes("'hand_after_custody', 'evidence', 'f06_hand_permits'"))
    out.push('the permit clause no longer refuses hand_after_custody');
  if (!permit.includes('h.table_id = p_table_id AND h.hand_number > p_hand_number'))
    out.push('the permit clause no longer reads the permits above the custody hand');
  if (!permit.includes("AND h.state <> 'never_started'"))
    out.push('a never_started permit is no longer the only state that is always admitted');
  const exemption = permit.match(/AND NOT \((.*?)\)\) THEN/);
  if (!exemption) {
    out.push('the abandoned reservation is still read as a hand after custody');
    return out;
  }
  const e = exemption[1];
  if (!e.includes("h.state = 'reserved'")) out.push('the exemption is not limited to reserved');
  if (/accepted|aborted_unsettled|h\.state IN|h\.state <>/.test(e))
    out.push('the exemption admits a state other than reserved');
  if (!e.includes('p_generation IS NOT NULL')) out.push('a caller with no generation is admitted');
  if (!e.includes('h.generation = p_generation'))
    out.push('a reservation of another generation is admitted');
  if (!e.includes('h.tournament_id = p_tournament_id'))
    out.push('a reservation of another tournament is admitted');
  if (/\bOR\b/.test(e)) out.push('the exemption is a disjunction');
  return out;
}

const { file, body } = latestDefinition();

describe('an abandoned reservation is not a hand after custody', () => {
  it('the latest definition keeps every rule', () => {
    expect(file >= FILE_NAME).toBe(true);
    expect(violations(body)).toEqual([]);
  });

  it('is one transaction, keeps every other refusal, and pins the new clause in its postimage', () => {
    const sql = readFileSync(join(MIGRATIONS, FILE_NAME), 'utf8');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '3s';");
    for (const refusal of [
      'STOPPED_CUSTODY_SERVICE_REQUIRED',
      "'table_not_in_tournament'",
      "'custody_transfer_busy'",
      "'mixed_transfer_recorded'",
      "'mixed_custody_adopted'",
      "'existing_park_unreadable'",
      "'newer_park'",
      "'concurrent_park'",
      'ON CONFLICT (table_id) DO NOTHING',
      'FOR UPDATE',
    ])
      expect(body).toContain(refusal);
    expect(body).not.toMatch(/ON CONFLICT \(table_id\) DO UPDATE/);
    // The door changes a refusal; it writes no permit, seat or chip row.
    expect(code(body)).not.toMatch(/UPDATE smarter_private\.f06_hand_permits/);
    expect(code(body)).not.toMatch(/table_seats|chip_balance|chip_ledger/);
    expect(sql).toContain("position('AND h.generation = p_generation' IN p.prosrc) = 0");
    expect(sql).toContain("position('AND h.tournament_id = p_tournament_id' IN p.prosrc) = 0");
    expect(sql).toContain("ARRAY['postgres=X/postgres', 'service_role=X/postgres']");
  });

  describe('each rule refuses its planted regression', () => {
    const plant = (from: string | RegExp, to: string) => {
      const mutated = body.replace(from, to);
      expect(mutated).not.toBe(body);
      return violations(mutated);
    };

    it('the shipped refusal (no exemption at all) is refused', () => {
      expect(
        plant(/\n\s*AND NOT \(h\.state = 'reserved'[\s\S]*?p_tournament_id\)\)/, ')')
      ).toContain('the abandoned reservation is still read as a hand after custody');
    });
    it('a reservation of any generation', () => {
      expect(plant('AND h.generation = p_generation', '')).toContain(
        'a reservation of another generation is admitted'
      );
    });
    it('a caller with no generation', () => {
      expect(plant('AND p_generation IS NOT NULL', '')).toContain(
        'a caller with no generation is admitted'
      );
    });
    it('a reservation of another tournament', () => {
      expect(plant('AND h.tournament_id = p_tournament_id', '')).toContain(
        'a reservation of another tournament is admitted'
      );
    });
    it('an accepted permit admitted beside the reservation', () => {
      expect(plant("(h.state = 'reserved'", "(h.state IN ('reserved', 'accepted')")).toContain(
        'the exemption admits a state other than reserved'
      );
    });
    it('a disjunction that admits every reservation', () => {
      expect(plant("h.state = 'reserved'\n", "h.state = 'reserved' OR true\n")).toContain(
        'the exemption is a disjunction'
      );
    });
    it('a recorded hand after the custody that no longer refuses', () => {
      expect(
        plant(
          'FROM public.hand_state_snapshots h\n              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number',
          'FROM public.hand_state_snapshots h\n              WHERE h.table_id = p_table_id AND false'
        )
      ).toContain('a recorded hand_state_snapshots row after the custody no longer refuses');
    });
  });
});
