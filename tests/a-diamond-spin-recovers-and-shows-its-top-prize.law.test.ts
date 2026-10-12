/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND SPIN RECOVERS AND SHOWS ITS TOP PRIZE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme: the two gaps the Diamond Spin left
 * open. A Spin whose launch was interrupted after it dealt (a hand persisted,
 * one player busted and vacated, the launch receipt still incomplete) is
 * finished through one narrow proof, fn_prove_played_spin_launch_recovery,
 * which read chip records only, so a Diamond Spin in that state stayed parked
 * with its entries in custody. The proof now routes a Diamond Spin to a
 * Diamond arm that proves the same facts from the records a Diamond Spin
 * keeps; the field, the felt, the vacated seat and the hand are the chip
 * rule's own text. The Diamond draw arm reads its field as the chip authority
 * does, so the committed draw replays for the proven field; the engine's
 * launch setup proof reads a Diamond Spin's draw where it read the chip
 * reserve ledger. And a filling Diamond Spin's card advertises the top of the
 * table its creation pinned, through a read door for signed-in players.
 *
 * The chip proof changes by one asserted substitution with the live md5
 * pinned and the reverse proved; the Diamond draw arm is pinned and redefined
 * with the same signature; the switch is never opened; nothing is priced.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_spin_recovers_and_shows_its_top_prize.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond Spin recovery migration is missing');
const MIG = migrationText(NAME);
const CHIP_PROOF = migrationText(
  '20260909183217_a_played_spin_with_one_vacated_busted_seat_can_complete_laun.sql'
);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const REGISTRY = section(
  '-- 1. THE NEW DOORS ARE DECLARED BEFORE THEY EXIST',
  '-- 2. THE DIAMOND ARM OF THE PLAYED-SPIN PROOF'
);
const ARM = section(
  '-- 2. THE DIAMOND ARM OF THE PLAYED-SPIN PROOF',
  '-- 3. THE PLAYED-SPIN PROOF ROUTES A DIAMOND SPIN TO ITS ARM'
);
const ROUTE = section(
  '-- 3. THE PLAYED-SPIN PROOF ROUTES A DIAMOND SPIN TO ITS ARM',
  '-- 4. THE DIAMOND DRAW ARM READS ITS FIELD AS THE CHIP AUTHORITY DOES'
);
const DRAW = section(
  '-- 4. THE DIAMOND DRAW ARM READS ITS FIELD AS THE CHIP AUTHORITY DOES',
  "-- 5. THE LOBBY READS A DIAMOND SPIN'S OWN TOP MULTIPLIER"
);
const CEILINGS = section(
  "-- 5. THE LOBBY READS A DIAMOND SPIN'S OWN TOP MULTIPLIER",
  '-- 6. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 6. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));
const cte = (s: string, from: string, to: string) => sliceBetween(s, from, to);

const SOURCE = (...path: string[]) => readFileSync(resolve(__dirname, '..', ...path), 'utf8');

describe('LAW: a Diamond Spin recovers and shows its top prize', () => {
  it('opens nothing, authorizes nothing and prices nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/INSERT\s+INTO\s+public\.poker_diamond_spin_reserve_source/i);
    expect(FINAL).toContain('this migration must not authorize a reserve source');
    expect(FINAL).toContain('this migration must not open the tournament door');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('declares both new doors before it creates them, as doors that move nothing', () => {
    for (const name of [
      'fn_poker_diamond_prove_played_spin_launch_recovery',
      'fn_poker_diamond_spin_ceilings',
    ]) {
      expect(REGISTRY).toContain(`('${name}', 'system',`);
      expect(MIG.indexOf(`('${name}', 'system',`)).toBeLessThan(
        MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
      );
    }
    expect(REGISTRY).toContain('Moves no money.');
  });

  it('routes a Diamond Spin to its arm by one asserted substitution of the chip proof', () => {
    expect(ROUTE.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).toHaveLength(1);
    expect(ROUTE.match(/IF md5\(replace\(/g) ?? []).toHaveLength(1);
    expect(ROUTE).toContain("v_old := E'SELECT CASE WHEN v.ok THEN\\n';");
    expect(ROUTE).toContain(
      "v_new := E'SELECT CASE WHEN public.fn_poker_diamond_tournament(p_tournament_id) THEN\\n"
    );
    expect(ROUTE).toContain(
      'public.fn_poker_diamond_prove_played_spin_launch_recovery(p_tournament_id)\\nWHEN v.ok THEN\\n'
    );
    expect(ROUTE).toContain('expected 1');
  });

  it('proves the field, the felt, the vacated seat and the hand by the chip rule, word for word', () => {
    const roster = cte(CHIP_PROOF, '), roster AS (\n', '), entitlements AS (\n');
    const felt = cte(CHIP_PROOF, '), table_evidence AS (\n', '), hands AS (\n');
    expect(ARM).toContain(roster);
    expect(ARM).toContain(felt);
    for (const line of [
      '          AND f.roster_count = 3',
      '          AND f.active_players = 2',
      '          AND f.eliminated_players = 1',
      '          AND f.zero_stack_eliminations = 1',
      '          AND f.roster_chips = f.funding_floor',
      '          AND f.live_seats = 2',
      '          AND f.matching_active_seats = 2',
      '          AND f.seat_chips = f.funding_floor',
      '          AND f.vacated_eliminated_players = 1',
      '          AND f.hand_count >= 1) AS ok',
    ]) {
      expect(CHIP_PROOF).toContain(line);
      expect(ARM).toContain(line);
    }
    // the hands are counted from the committed Diamond draw
    expect(ARM).toContain(
      'count(h.id) FILTER (WHERE h.created_at >= r.draw_created_at) AS hand_count\n    FROM draw_evidence r'
    );
  });

  it('reads the money from the records a Diamond Spin keeps, and no chip record', () => {
    expect(ARM).toContain('AND public.fn_poker_diamond_tournament(t.id)');
    expect(ARM).toContain(
      "FROM public.poker_diamond_tournament_ledger l\n   WHERE l.tournament_id = p_tournament_id\n     AND l.kind = 'entry'"
    );
    expect(ARM).toContain("AND m.source_account = 'player:' || m.user_id::text");
    expect(ARM).toContain("AND c.state = 'active'");
    expect(ARM).toContain("AND c.entry_key = 'entry:' || l.registration_id::text");
    expect(ARM).toContain('AND m.wallet_journal_id = l.wallet_journal_id');
    expect(ARM).toContain('AND j.amount = -l.amount');
    expect(ARM).toContain('FROM public.spin_draw_receipts r');
    expect(ARM).toContain('public.fn_poker_diamond_spin_draw_proof(p_tournament_id, NULL)');
    expect(ARM).toContain('FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e');
    for (const line of [
      '          AND f.entitlement_count = 3',
      '          AND f.payment_count = 3',
      '          AND f.exact_source_charges = 3',
      '          AND f.draw_count = 1',
      '          AND f.draw_proven',
      '          AND f.draw_pool = round(f.buy_in * f.draw_multiplier, 2)',
      '          AND f.draw_seats = 3',
      '          AND f.custody_total = f.draw_pool',
      '          AND f.prize_balance = f.draw_pool',
    ]) {
      expect(ARM).toContain(line);
    }
    const body = code(ARM);
    for (const chip of [
      'tournament_refund_entitlements',
      'wallet_transactions',
      'chip_ledger',
      'spin_reserve_ledger',
      'spin_bonus_pools',
      'public.tournament_escrow',
    ]) {
      expect(body).not.toContain(chip);
    }
  });

  it("answers in the chip answer's shape, so every reader takes it unchanged", () => {
    const answer = (s: string) =>
      s.slice(s.indexOf('SELECT CASE WHEN v.ok THEN'), s.indexOf('FROM verdict v;'));
    expect(answer(ARM)).toBe(answer(CHIP_PROOF));
    expect(ARM).toContain("'reason', 'played_spin_launch_recovery_unproven'");
    expect(ARM).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_prove_played_spin_launch_recovery(uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it('replays a committed Diamond draw for a proven played field, as the chip authority does', () => {
    expect(DRAW).toMatch(/IF v_md5 <> '[0-9a-f]{32}' THEN/);
    expect(DRAW).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)'
    );
    expect(DRAW).toContain(
      '  IF v_count = 2 THEN\n    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);'
    );
    expect(DRAW).toContain(
      "WHERE p.tournament_id = p_tournament_id AND p.status IN ('playing', 'eliminated');"
    );
    expect(DRAW).toContain("OR (v_played_recovery AND p.status = 'eliminated'))");
    // the field is proved before the committed receipt is replayed
    expect(DRAW.indexOf('v_played_recovery := true;')).toBeLessThan(
      DRAW.indexOf("RETURN v_saved.receipt || jsonb_build_object('replay', true);")
    );
    expect(DRAW).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it("lets a signed-in player read a Diamond Spin's own top, and nothing else", () => {
    expect(CEILINGS).toContain('STABLE SECURITY DEFINER');
    expect(CEILINGS).toContain("max((x.value->>'multiplier')::numeric)");
    expect(CEILINGS).toContain('FROM public.poker_diamond_spin_contracts k');
    expect(CEILINGS).toContain('k.tournament_id = ANY (p_tournament_ids[1:500])');
    expect(CEILINGS).toContain('AND public.fn_poker_diamond_tournament(k.tournament_id)');
    expect(CEILINGS).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_ceilings(uuid[]) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CEILINGS).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_spin_ceilings(uuid[]) TO authenticated;'
    );
    expect(code(CEILINGS)).not.toMatch(/GRANT[^;]*TO\s+anon/i);
    expect(code(CEILINGS)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(FINAL).toContain('the pinned Spin contracts became readable from a browser');
  });

  it('the engine proves a Diamond Spin launch by its draw, and the lobby reads its own top', () => {
    const manager = SOURCE('server', 'src', 'tournament', 'TournamentManagerBase.ts');
    expect(manager).toContain("'fn_poker_diamond_spin_draw_proof'");
    expect(manager).toContain('this.tournamentUnit() === DIAMOND_UNIT_CENTS');
    const lobby = SOURCE('src', 'components', 'lobby', 'lobbyEntries.ts');
    expect(lobby).toContain(
      'if (tournamentRowUnitCents(t) !== DIAMOND_UNIT_CENTS) return SPIN_MAX_MULTIPLIER;'
    );
    expect(SOURCE('src', 'services', 'diamondSpinCeilings.ts')).toContain(
      "supabase.rpc('fn_poker_diamond_spin_ceilings'"
    );
    for (const page of [
      ['src', 'pages', 'ClubHomePage.tsx'],
      ['src', 'pages', 'tournament', 'TournamentLobbyPage.tsx'],
    ]) {
      const text = SOURCE(...page);
      expect(text).toContain('TOURNAMENT_ARENA_EMBED');
      expect(text).toContain('withDiamondSpinCeilings(');
    }
  });
});
