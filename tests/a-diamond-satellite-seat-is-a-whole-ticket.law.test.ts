/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND SATELLITE SEAT IS A WHOLE TICKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme, third piece: Diamond-to-Diamond
 * satellites. A satellite pays its prize bank in seats - whole tickets into
 * its target, each the target's buy-in plus its fee - and whatever the bank
 * holds beyond a whole number of tickets as money to the single bubble. The
 * chip estate's two settlement authorities, their receipt readers, the award
 * capture trigger and the creation guard are reused whole. What a Diamond
 * satellite needed is a seat that is custody: the qualifier's target entry is
 * a new ACTIVE custody row funded out of the satellite's prize bank by a new
 * owner-only door (fn_poker_diamond_tournament_seat_transfer), with a ledger
 * row on each side, and no wallet moves.
 *
 * The law pins the decisions the rehearsal proved: the unit divides nowhere
 * (a Diamond pool, ticket and remainder are whole, and a residue is refused
 * by name before any Diamond moves); the assets never cross, refused by name
 * at the creation door, in the guard every satellite row passes through and
 * in both settlement authorities; duplicate qualification is the chip rule,
 * untouched; the readiness contract takes a Diamond satellite that promises
 * no seat, because a promised seat is a guarantee and a Diamond guarantee is
 * not built; the new door is registered before it exists, revoked from every
 * client role, watched and declared; every chip edit is an asserted
 * substitution with its live md5 pinned and the reverse proved; the switch is
 * never opened and nothing is priced.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_satellite_seat_is_a_whole_ticket.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond satellite migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const H = {
  registry: '-- 1. THE SEAT DOOR IS REGISTERED BEFORE IT EXISTS',
  rule: '-- 2. ASSETS NEVER CROSS: THE RULE AND THE DIAMOND FEEDER PREDICATE',
  seat: "-- 3. THE SEAT DOOR: A QUALIFIER'S TARGET ENTRY IS FUNDED CUSTODY TO CUSTODY",
  guard: '-- 4. THE CREATION GUARD EVERY SATELLITE ROW PASSES THROUGH: ASSETS NEVER CROSS',
  door: '-- 5. THE DIAMOND CREATION DOOR ADMITS A SATELLITE INTO A DIAMOND TARGET',
  ready: '-- 5b. A DIAMOND SATELLITE PROMISES NO SEAT, AND ITS CONTRACT IS COMPLETE',
  single: '-- 6. THE SINGLE-WINNER AUTHORITY DELIVERS A DIAMOND SEAT',
  cohort: '-- 7. THE COHORT AUTHORITY DELIVERS A DIAMOND SEAT',
  receipt: '-- 8a. THE SINGLE-WINNER RECEIPT READS THE DIAMOND EVIDENCE',
  cohortReceipt: '-- 8b. THE COHORT RECEIPT READS THE DIAMOND EVIDENCE',
  capture: "-- 9. A DIAMOND SEAT'S REFUND ENTITLEMENT IS ITS CUSTODY ROW",
  award: '-- 10a. THE CHIP-RAIL SEAT DOOR REFUSES A DIAMOND SATELLITE',
  finish: '-- 10b. THE CHIP-RAIL ENTITLEMENT FINISH REFUSES A DIAMOND SATELLITE',
  watch: '-- 11. THE SEAT DOOR IS WATCHED, AND DECLARED',
  final: '-- 12. THE ESTATE IS AS IT WAS',
};
const HEAD = MIG.slice(0, MIG.indexOf(H.registry));
const REGISTRY = section(H.registry, H.rule);
const RULE = section(H.rule, H.seat);
const SEAT = section(H.seat, H.guard);
const GUARD = section(H.guard, H.door);
const DOOR = section(H.door, H.ready);
const READY = section(H.ready, H.single);
const SINGLE = section(H.single, H.cohort);
const COHORT = section(H.cohort, H.receipt);
const RECEIPT = section(H.receipt, H.cohortReceipt);
const COHORT_RECEIPT = section(H.cohortReceipt, H.capture);
const CAPTURE = section(H.capture, H.award);
const AWARD = section(H.award, H.finish);
const FINISH = section(H.finish, H.watch);
const WATCH = section(H.watch, H.final);
const FINAL = code(section(H.final, 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});
// The forward edit of an asserted substitution with n clauses, as the block runs it.
const forwardChain = (n: number) =>
  'EXECUTE ' +
  'replace('.repeat(n) +
  'v_def, v_old1, v_new1)' +
  Array.from({ length: n - 1 }, (_, i) => `, v_old${i + 2}, v_new${i + 2})`).join('') +
  ';';

describe('LAW: a Diamond satellite seat is a whole ticket', () => {
  it('opens nothing, prices nothing and runs in the caller transaction', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(FINAL).toContain('this migration must not open the tournament door');
    // A promised seat count is a guarantee: refused at the door, stamped zero on the row.
    expect(DOOR).toContain(
      "IF COALESCE(NULLIF(p_config->>'satelliteSeats','')::numeric,0)<>0 THEN"
    );
    expect(DOOR).toContain('diamond_satellite_seat_guarantee_not_open');
    expect(DOOR).toContain(
      'CASE WHEN v_satellite THEN v_target_id END, CASE WHEN v_satellite THEN 0 END)'
    );
    expect(DOOR).toContain("IF COALESCE((p_config->>'guarantee')::numeric,0)<>0");
    // The ticket is the target's own price and nothing else.
    expect(SEAT).toContain('diamond_satellite_seat_is_not_the_target_entry');
    expect(SEAT).toContain(
      'IF v_target.buy_in_amount IS DISTINCT FROM p_prize OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM p_fee'
    );
    expect(HEAD).toContain('Nothing is priced: the ticket is the target');
  });

  it('every chip edit is an asserted substitution with its live md5 pinned and the reverse proved', () => {
    expect(pinnedEdits(MIG)).toEqual({ pins: 10, reversals: 10 });
    for (const [s, pin, clauses] of [
      [GUARD, '69247df72bfb68c7148c1a7f9ea4cfd7', 5],
      [READY, '0b9fecc5c10bdcf459510bbb19a3268a', 1],
      [SINGLE, '9c5dd58bbae1d4ad4c1f5c808948da4d', 12],
      [COHORT, '6e9822dd8367827cf2ba31f2c41b4771', 12],
      [RECEIPT, '5288fd960eac2c85d955b8c8150f9f93', 7],
      [COHORT_RECEIPT, '3207bb2d0d632688e10889bb7ef8ed08', 7],
      [CAPTURE, '43bd57fdb0a21738e5b1e5d833c94a57', 1],
      [AWARD, '92ab8b6d14cecd75bb945bbe2e6bc12b', 1],
      [FINISH, '399bdb8716ec24166880d3df7e017280', 1],
      [WATCH, '92ee208d0887728444bda396d0b4d442', 1],
    ] as const) {
      expect(pinnedEdits(s)).toEqual({ pins: 1, reversals: 1 });
      expect(s).toContain(`IF md5(v_def) <> '${pin}' THEN`);
      expect(s).toContain(`IF md5(replace(`);
      expect(s).toContain(`) <> '${pin}' THEN`);
      expect(s).toContain(forwardChain(clauses));
      expect(s).toContain(
        "    v_n := (length(v_def) - length(replace(v_def, v_clause, ''))) / length(v_clause);"
      );
    }
    // The creation door is pinned and redefined with the same signature.
    expect(DOOR).toMatch(/IF v_md5 <> '[0-9a-f]{32}' THEN/);
    expect(DOOR).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)'
    );
  });

  it('the seat door is registered before it exists and no client role reaches it', () => {
    expect(REGISTRY).toContain(
      'INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES'
    );
    expect(REGISTRY).toContain("('fn_poker_diamond_tournament_seat_transfer', 'approved',");
    expect(MIG.indexOf("('fn_poker_diamond_tournament_seat_transfer', 'approved',")).toBeLessThan(
      MIG.indexOf('CREATE FUNCTION public.fn_poker_diamond_tournament_seat_transfer(')
    );
    expect(SEAT).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_seat_transfer(uuid,uuid,uuid,uuid,numeric,numeric,numeric,text)\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(RULE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_assert_satellite_asset(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(RULE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_diamond_satellite_target_accepts_new_feeder(uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(code(SEAT + RULE)).not.toMatch(/GRANT\s+EXECUTE/i);
  });

  it('a seat moves custody to custody: out of the prize bank, into a new active entry, a ledger row each side, no wallet', () => {
    const body = code(SEAT);
    // out: the drain releases the satellite's entry rows into the new entry row
    expect(SEAT).toContain(
      "v_drained := public.fn_poker_diamond_tournament_drain(\n    p_satellite_id, 'prize', p_ticket::bigint, v_out_key, 'arena_custody:'||v_custody::text, v_journal);"
    );
    expect(SEAT).toContain(
      "VALUES (p_satellite_id,v_sat.club_id,p_user_id,NULL,'prize',p_ticket::bigint,p_ticket::bigint,0,0,"
    );
    // in: a new ACTIVE entry custody row, named for the registration, never bound to a seat
    expect(SEAT).toContain(
      "VALUES (v_custody,p_user_id,v_target.club_id,'tournament_entry',p_target_id,\n    'entry:'||p_registration_id::text,p_ticket::bigint,'active');"
    );
    expect(SEAT).toContain(
      "VALUES (v_request,v_custody,p_user_id,'reserve',p_ticket::bigint,\n    'tournament_prize_bank:'||p_satellite_id::text,'arena_custody:'||v_custody::text,v_journal,"
    );
    expect(SEAT).toContain(
      "VALUES (p_target_id,v_target.club_id,p_user_id,v_custody,'entry',p_ticket::bigint,p_prize::bigint,0,p_fee::bigint,"
    );
    expect(SEAT).toContain(
      "jsonb_build_object('kind','entry','source','satellite_seat','satellite_id',p_satellite_id,'gross',p_ticket,"
    );
    // the one journal row the movements carry moves no wallet
    expect(SEAT).toContain(
      "VALUES (p_user_id,'tournament_satellite_seat','tournament_satellite_seat',0,v_wallet,"
    );
    expect(SEAT).toContain("'wallet_moved',0,");
    expect(body).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.chip_ledger/i);
    // replay returns what the first call wrote; both events' banks equal their custody after
    expect(SEAT).toContain(
      'SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_in_key;'
    );
    expect(SEAT).toContain("RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody'");
    for (const rule of [
      'diamond_satellite_seat_requires_whole_parts',
      'diamond_satellite_seat_requires_two_diamond_events',
      'diamond_satellite_seat_names_another_target',
      'diamond_satellite_seat_is_not_the_target_entry',
      'diamond_satellite_seat_has_no_qualifier_registration',
      'diamond_tournament_entry_already_held',
      'diamond_tournament_bank_short',
      'idempotency_payload_mismatch',
    ]) {
      expect(SEAT).toContain(rule);
    }
  });

  it('where the unit divides: nowhere - both authorities refuse a residue by name before any Diamond moves', () => {
    expect(HEAD).toContain('WHERE THE UNIT DIVIDES: NOWHERE');
    for (const s of [SINGLE, COHORT]) {
      expect(s).toContain('v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);');
      expect(s).toContain(
        'IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)'
      );
      expect(s).toContain(
        'OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)'
      );
      expect(s).toContain(
        'OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)'
      );
      expect(s).toContain(
        "'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %'"
      );
      // anchored on the chip remainder line itself, so it runs before the award loop
      expect(s).toContain(
        '$o$  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);\n$o$'
      );
    }
    expect(SEAT).toContain(
      'OR p_ticket <> trunc(p_ticket) OR p_prize <> trunc(p_prize) OR p_fee <> trunc(p_fee)'
    );
  });

  it('assets never cross: refused by name at the creation door, in the guard every row passes and at settlement', () => {
    expect(DOOR).toContain('IF NOT public.fn_poker_diamond_tournament(v_target_id) THEN');
    expect(DOOR).toContain('diamond_satellite_target_must_be_a_diamond_tournament');
    expect(GUARD).toContain(
      "RAISE EXCEPTION 'SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET' USING ERRCODE='22023';"
    );
    expect(GUARD).toContain(
      "RAISE EXCEPTION 'SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET' USING ERRCODE='22023';"
    );
    expect(GUARD).toContain(
      'THEN public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target)'
    );
    expect(GUARD).toContain('ELSE public.fn_ca_satellite_target_accepts_new_feeder(v_target) END)');
    // the asset of a satellite with a live target may not change under it
    expect(GUARD).toContain('OR v_source_diamond IS DISTINCT FROM');
    expect(RULE).toContain('diamond_satellite_cannot_seat_a_chip_target');
    expect(RULE).toContain('chip_satellite_cannot_seat_a_diamond_target');
    expect(RULE).toContain('AND public.fn_poker_diamond_tournament(t.id) IS TRUE');
    for (const s of [SINGLE, COHORT]) {
      expect(s).toContain(
        'v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);'
      );
    }
    for (const s of [AWARD, FINISH]) {
      expect(s).toContain('diamond_satellite_is_never_settled_on_chip_rails');
    }
  });

  it('both authorities deliver a Diamond seat through the seat door in place of the chip legs', () => {
    for (const s of [SINGLE, COHORT]) {
      // The seat is written right after the registration receipt: before the
      // cohort's RUNNING-target late seat, because a Diamond tournament chair
      // is admitted only against an active funded entry (P0810).
      const receipt =
        "        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',\n" +
        "          p_tournament_id, v_place USING ERRCODE = 'P0404';\n" +
        '      END IF;\n';
      expect(s).toContain(
        receipt +
          '      IF v_diamond THEN\n        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT.'
      );
      expect(s).toContain(
        'IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs'
      );
      expect(s).toContain(
        'PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);'
      );
      expect(s).toContain('v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(');
      expect(s).toContain(
        "'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);"
      );
      expect(s).toContain("OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN");
      expect(s).toContain('END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs');
      expect(s).toContain('IF v_seat_count > 0 AND NOT v_diamond AND (');
      expect(s).toContain('IF v_seat_count > 0 AND NOT v_diamond THEN');
      expect(s).toContain('IF v_seat_count > 0 AND v_diamond THEN');
      expect(s).toContain(
        'IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost'
      );
      expect(s).toContain('diamond_satellite_winner_at_the_table_cap');
    }
  });

  it('duplicate qualification is the chip rule: no clause touches it', () => {
    expect(HEAD).toContain('DUPLICATE QUALIFICATION is the chip rule, unchanged');
    for (const s of [SINGLE, COHORT]) {
      expect(s).not.toContain("v_delivery_kind := 'cash'");
      expect(s).not.toContain("'satellite_ticket'");
      expect(s).not.toContain('v_existing_target');
    }
  });

  it('the receipts prove a Diamond seat by its Diamond evidence and keep the chip evidence for chip seats', () => {
    for (const s of [RECEIPT, COHORT_RECEIPT]) {
      expect(s).toContain(
        'v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9'
      );
      expect(s).toContain(
        "ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key"
      );
      expect(s).toContain(
        "ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key"
      );
      expect(s).toContain("OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)");
      expect(s).toContain("'satellite % has malformed or extra Diamond seat evidence'");
      expect(s).toContain('IF NOT v_diamond AND (EXISTS (');
      expect(s).toContain(
        'IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)'
      );
      expect(s).toContain('SELECT e.fee_balance + e.fee_out INTO v_rake');
    }
  });

  it("the award capture trigger takes a Diamond seat's custody row as its refund entitlement", () => {
    expect(CAPTURE).toContain('IF public.fn_poker_diamond_tournament(NEW.tournament_id) THEN');
    expect(CAPTURE).toContain(
      "WHERE li.idempotency_key = 'poker-tournament-seat-in:' || NEW.idempotency_key"
    );
    expect(CAPTURE).toContain(
      "'Diamond satellite seat award has no exact custody-to-custody evidence'"
    );
  });

  it('the readiness contract takes a Diamond satellite that promises no seat, and keeps the chip rule', () => {
    expect(HEAD).toContain('A DIAMOND SATELLITE PROMISES NO SEAT');
    expect(READY).toContain(
      'OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL'
    );
    expect(READY).toContain("WHERE c.id = v_club AND c.asset = 'diamonds'");
    expect(READY).toContain('AND c.is_platform IS TRUE AND c.union_id IS NULL)');
    expect(READY).toContain('AND public.fn_poker_diamond_tournament(v_target))');
    // the chip clause survives verbatim: once in the old text, once in the new
    expect(
      READY.split('OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)').length -
        1
    ).toBe(2);
  });

  it("the creation door admits 'satellite' into a Diamond target and on nothing else", () => {
    expect(DOOR).toContain(
      "IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty','satellite') THEN"
    );
    for (const rule of [
      'diamond_tournament_format_not_open',
      'diamond_tournament_target_requires_a_satellite_format',
      'diamond_satellite_requires_a_target',
      'diamond_satellite_target_must_be_a_diamond_tournament',
      'diamond_satellite_target_cannot_take_a_satellite',
      'diamond_satellite_target_is_not_open',
      'diamond_satellite_seat_guarantee_not_open',
      'diamond_satellite_is_a_freezeout',
      'diamond_satellite_must_start_before_its_target',
      'diamond_tournament_would_not_be_recognised',
    ]) {
      expect(DOOR).toContain(rule);
    }
    expect(DOOR).toContain('IF NOT public.fn_is_platform_admin() THEN');
    expect(DOOR).toContain(
      "CASE WHEN v_type='sng' THEN 'SNG' WHEN v_satellite THEN 'SATELLITE' ELSE 'MTT' END"
    );
    expect(DOOR).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) FROM PUBLIC, anon;'
    );
    expect(DOOR).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;'
    );
  });

  it('the seat door is on the guard watchlist, and both redefinitions are declared', () => {
    expect(WATCH).toContain(
      "      'fn_poker_diamond_tournament_seat_transfer',\n      -- And the list itself.\n      'fn_ca_guard_watchlist'"
    );
    expect(WATCH).toContain('the seat door is not on the guard watchlist');
    expect(WATCH).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_seat_transfer',"
    );
    expect(WATCH).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_guard_watchlist',"
    );
  });

  it('asserts at the end that every edit landed, no client reaches a new step, the identity is whole and every watched guard is on its baseline', () => {
    for (const phrase of [
      'does not deliver a Diamond seat beside its chip seat as this migration states',
      'does not read the Diamond seat evidence as this migration states',
      'the award capture trigger does not know a Diamond seat',
      'the creation guard does not keep the assets apart',
      'the creation door does not admit a Diamond satellite as this migration states',
      'the readiness contract does not take a Diamond satellite promising no seat',
      'does not refuse a Diamond satellite',
      'is callable by a client role; it is an internal step',
      'is reachable without an account',
      'the seat door is not registered',
      'the Diamond identity is not whole',
      'watched guards off their baseline',
    ]) {
      expect(FINAL).toContain(phrase);
    }
  });

  // Added 2026-10-04. Every assertion above reads the MIGRATION TEXT, which
  // proves the migration said something and not that the installed door does
  // it. The Diamond tournament lifecycle fixture now EXECUTES the seat door
  // against its md5-pinned capture on isolated PostgreSQL 17, and this holds
  // that open: the door must stay in the capture, and the cases must keep
  // reaching each refusal by name. Deleting a case fails here.
  it('the lifecycle fixture executes the seat door, and each refusal is reached by name', () => {
    const SQL = join(__dirname, 'sql');
    const capture = readFileSync(join(SQL, 'diamond-tournament-lifecycle-doors.sql'), 'utf8');
    const cases = readFileSync(join(SQL, 'diamond-tournament-lifecycle-cases.sql'), 'utf8');

    // The installed door is captured, md5-pinned, and owner-only.
    expect(capture).toContain('-- @@DOOR fn_poker_diamond_tournament_seat_transfer(');
    expect(capture).toMatch(
      /-- @@DOOR fn_poker_diamond_tournament_seat_transfer\([^\n]*\n-- @@PIN md5=[0-9a-f]{32} len=\d+ owner=postgres\n/
    );
    expect(capture).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_seat_transfer(uuid, uuid, uuid, uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated, service_role;'
    );

    // The cases call the installed door, not a stand-in.
    expect(cases).toContain('public.fn_poker_diamond_tournament_seat_transfer(');

    // Every refusal the door carries is reached by name. The divider first.
    for (const reason of [
      'diamond_satellite_seat_requires_whole_parts',
      'diamond_satellite_seat_requires_two_diamond_events',
      'diamond_satellite_seat_names_another_target',
      'diamond_satellite_seat_is_not_the_target_entry',
      'diamond_satellite_seat_has_no_qualifier_registration',
      'diamond_tournament_entry_already_held',
      'poker_diamond_one_open_entry',
    ]) {
      expect(cases, `the fixture must reach ${reason}`).toContain(`'${reason}')`);
    }

    // The divider is exercised more than once: a fractional ticket, a
    // fractional prize, a fractional fee, parts that do not add up, a seat for
    // nothing and a movement with no key.
    expect(
      cases.split('diamond_satellite_seat_requires_whole_parts').length - 1
    ).toBeGreaterThanOrEqual(6);

    // And the refusals are proved to have moved nothing.
    expect(cases).toContain('satellite seat: every refusal moved nothing');

    // The fixture still opens no switch.
    expect(cases).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*(?::?=)\s*(?:true|'t')/i);
  });
});
