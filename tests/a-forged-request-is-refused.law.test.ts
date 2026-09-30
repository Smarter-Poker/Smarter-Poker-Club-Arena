/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A FORGED REQUEST IS REFUSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Diamond Arena Phase 11, line 1 ("Test cross-asset request forgery and
 * unauthorized membership/management access"). The attack found three holes
 * and migration 20260930120000 closes them, each by asserted substitution:
 *
 *   1. fourteen Diamond staff doors trusted a signed-out token: each now asks
 *      fn_caller_session_is_live() right after its staff check and refuses
 *      with diamond_staff_session_required, as the five Phase 10 doors do;
 *   2. the Diamond Arena resolved as a club-games host: fn_wheel_host finds no
 *      host for a Diamond club;
 *   3. any club owner, union owner or incident recipient could operate or read
 *      another host's club games: fn_wheel_can_operate admits platform staff,
 *      not fn_ca_caller_is_management(), to a host that is not theirs.
 *
 * The evidence - every door a forger can reach, refused by name in a
 * rolled-back production rehearsal - is
 * docs/evidence/diamond-phase-11/request-forgery-and-access.md.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_forged_request_is_refused.sql'))
  .at(-1);
if (!NAME) throw new Error('the forged-request migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const EDITS = sliceBetween(
  MIG,
  '-- 1, 2 and 3: every edit, one asserted substitution each',
  '-- What must be true now'
);
const FINAL = sliceBetween(
  MIG,
  '-- What must be true now',
  "RAISE NOTICE 'a forged request is refused"
);

const STAFF_DOORS = [
  'fn_poker_diamond_open_cash_table',
  'fn_poker_diamond_set_table_straddle',
  'fn_poker_diamond_set_table_run_it_twice',
  'fn_poker_diamond_set_table_bomb_pot',
  'fn_poker_diamond_create_tournament',
  'fn_ca_diamond_adjustment_propose',
  'fn_ca_diamond_adjustment_approve',
  'fn_ca_diamond_adjustment_reject',
  'fn_ca_diamond_adjustment_settle',
  'fn_ca_diamond_staff_books',
  'fn_ca_diamond_incident_review',
  'fn_ca_diamond_incident_resolve_family',
  'fn_ca_diamond_incident_board',
  'fn_ca_diamond_incident_trail',
];
/** The five Phase 10 doors that already asked, and must still ask. */
const ALREADY_ASKED = [
  'fn_poker_diamond_edit_cash_table',
  'fn_poker_diamond_close_cash_table',
  'fn_poker_diamond_remove_tournament_player',
  'fn_poker_diamond_cancel_tournament',
  'fn_poker_diamond_create_seat_first_board',
];

/** Each VALUES row of the edit loop: function, pin, old clause, new clause. */
const ROWS = [
  ...EDITS.matchAll(
    /\(\$f\$([a-z_]+)\$f\$, \$p\$([0-9a-f]{32})\$p\$,\s*\$o\$([\s\S]*?)\$o\$,\s*\$n\$([\s\S]*?)\$n\$\)/g
  ),
].map((m) => ({ fn: m[1], pin: m[2], old: m[3], neu: m[4] }));
const row = (fn: string) => {
  const r = ROWS.find((x) => x.fn === fn);
  if (!r) throw new Error(`${fn} is not edited`);
  return r;
};

describe('LAW: a forged request is refused', () => {
  it('opens nothing, grants nothing and moves nothing', () => {
    const body = code(MIG);
    expect(body).not.toMatch(/(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(body).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(body).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
    expect(body).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TABLE|TRIGGER|POLICY)/i);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('every edit is an asserted substitution against a pinned live text', () => {
    expect(ROWS.map((r) => r.fn).sort()).toEqual(
      [...STAFF_DOORS, 'fn_wheel_host', 'fn_wheel_can_operate'].sort()
    );
    const loop = code(EDITS);
    expect(loop).toContain('IF md5(v_def) <> r.pin THEN');
    expect(loop).toContain(
      "v_n := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);"
    );
    expect(loop).toContain('IF v_n <> 1 THEN');
    expect(loop).toContain('EXECUTE replace(v_def, r.old, r.new);');
    expect(loop).toContain(
      'IF md5(replace(pg_get_functiondef(v_oid), r.new, r.old)) <> r.pin THEN'
    );
    for (const r of ROWS)
      expect(MIG, `${r.fn} pin is listed in the header`).toMatch(
        new RegExp(`--\\s+${r.fn}\\s+${r.pin}`)
      );
  });

  it('each of the fourteen staff doors asks for a live session right after its staff check', () => {
    for (const fn of STAFF_DOORS) {
      const { old, neu } = row(fn);
      expect(old, fn).toContain('fn_is_platform_admin()');
      // the staff check survives verbatim; the session check follows it
      expect(neu.startsWith(`${old}\n`), fn).toBe(true);
      const added = neu.slice(old.length + 1);
      expect(added, fn).toContain('IF NOT public.fn_caller_session_is_live() THEN');
      expect(added, fn).toContain("'diamond_staff_session_required'");
      // a door that raised still raises, a door that answered still answers
      if (/RAISE EXCEPTION/.test(old))
        expect(added, fn).toContain(
          "RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';"
        );
      else if (/'refused_reason'/.test(old))
        expect(added, fn).toContain(
          "RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_staff_session_required');"
        );
      else
        expect(added, fn).toContain(
          "RETURN jsonb_build_object('success', false, 'error', 'diamond_staff_session_required');"
        );
    }
  });

  it('the Diamond Arena is no club-games host', () => {
    const { old, neu } = row('fn_wheel_host');
    expect(old).toBe('    FROM public.clubs c WHERE c.id = p_club_id;');
    expect(neu).toContain("     AND c.asset IS DISTINCT FROM 'diamonds';");
    expect(FINAL).toContain('fn_wheel_host still finds the Diamond Arena as a host');
    expect(FINAL).toContain('fn_wheel_host no longer finds a chip club');
  });

  it("only platform staff operate another host's games", () => {
    const { old, neu } = row('fn_wheel_can_operate');
    expect(old).toBe('  IF public.fn_ca_caller_is_management() THEN RETURN true; END IF;');
    expect(code(neu)).not.toContain('fn_ca_caller_is_management');
    expect(neu).toContain('  IF public.fn_is_platform_admin() THEN RETURN true; END IF;');
    expect(FINAL).toContain(
      'fn_wheel_can_operate still admits more than platform staff to another host'
    );
    expect(FINAL).toContain('fn_wheel_can_operate is reachable from a browser');
  });

  it('the end state is asserted for all nineteen staff doors and proved live', () => {
    for (const fn of [...STAFF_DOORS, ...ALREADY_ASKED]) expect(FINAL, fn).toContain(`'${fn}'`);
    expect(FINAL).toContain('expected nineteen Diamond staff doors');
    expect(FINAL).toContain('does not ask for staff and then a live session');
    expect(FINAL).toContain('is reachable without an account');
    const proofs = MIG.match(/^-- @live-proof: .+$/gm) ?? [];
    expect(proofs).toHaveLength(3);
    expect(proofs[0]).toContain('count(*) = 14');
    for (const fn of STAFF_DOORS) expect(proofs[0], fn).toContain(`'${fn}'`);
  });
});
