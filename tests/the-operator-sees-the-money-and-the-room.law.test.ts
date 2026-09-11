/**
 * THE OPERATOR SEES THE MONEY AND THE ROOM (2026-09-11, BINDING)
 *
 * Phase 3 of 6. A host runs three games that take diamonds in and pay chips out
 * of a wallet the host funds, and until now the consoles answered neither of
 * the two questions an operator actually has.
 *
 *   "What did this earn me?"  Balances are a photograph, and the realised-return
 *   windows are about fairness rather than money: they state what fraction of
 *   the intake came back out as chips and they do not count the diamond prizes
 *   at all, so the one figure an owner cares about appeared nowhere.
 *
 *   "How close am I to it stopping?"  The cover reading goes red at zero, by
 *   which point the games have been refusing bets for a while, because each one
 *   caps the multiplier it will offer by what the cover can pay.
 *
 * WHAT THIS LAW HOLDS.
 *
 *   - the net is stated as arithmetic on money that actually moved, and the
 *     welcome spins are separated out rather than buried in it;
 *   - fixtures are excluded and an open crash round is excluded, because it has
 *     taken the bet and not decided the payout;
 *   - horses are NOT excluded and are never asked about by any other name
 *     (CLAUDE.md 10.5);
 *   - the room reading comes from fn_diamond_game_cap_cents, the same function
 *     the door uses, so the console cannot say one thing while the game does
 *     another;
 *   - and it distinguishes the two ceilings. The intake headroom is the
 *     never-pay-more-than-taken-in law working and needs nothing from the
 *     operator; the cover is theirs to fix. Reporting them as one number would
 *     tell an owner to move chips they do not need to move, which is exactly
 *     what the first cut of this did until a probe caught it calling a fully
 *     funded game "thin";
 *   - none of it runs on a schedule. 10.12 forbids a monitor, a watch or an
 *     alert presented as the resolution, and these are reads computed when the
 *     operator opens a page they already open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { functionBody as body, latestDeclaring as inForce } from './helpers/migrations';

const ROOT = resolve(__dirname, '..');

const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PNL = body(inForce('fn_diamond_game_pnl').sql, 'fn_diamond_game_pnl');
const ROOM = body(inForce('fn_diamond_game_room').sql, 'fn_diamond_game_room');
const PLAYERS = body(inForce('fn_diamond_game_players').sql, 'fn_diamond_game_players');
const READS: Array<[string, string]> = [
  ['fn_diamond_game_pnl', PNL],
  ['fn_diamond_game_room', ROOM],
  ['fn_diamond_game_players', PLAYERS],
];

describe('they are reads, and only the host may take them', () => {
  it.each(READS)('%s asks who is calling and what they may do', (_n, sql) => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('public.fn_wheel_can_operate(v_host, v_kind, v_user)');
  });

  it.each(READS)('%s writes nothing', (_n, sql) => {
    expect(sql).not.toMatch(/\bINSERT INTO\b/);
    expect(sql).not.toMatch(/\bUPDATE public\./);
    expect(sql).not.toMatch(/\bDELETE FROM\b/);
  });

  it.each(['fn_diamond_game_pnl(uuid)', 'fn_diamond_game_room(uuid)'])(
    '%s is revoked from PUBLIC and anon',
    (sig) => {
      const sql = inForce(sig.split('(')[0]).sql;
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM anon;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  );
});

describe('the net is money that actually moved', () => {
  it('is stated as its own arithmetic, in chips', () => {
    expect(PNL).toContain(
      "'net_chips', round(p.intake_dia / v_rate - p.chips_out - p.dia_out / v_rate - p.welcome_chips, 2)"
    );
  });

  it('counts the diamond prizes the realised-return windows never did', () => {
    expect(PNL).toContain("WHEN s.outcome_kind = 'diamonds' THEN COALESCE(s.outcome_amount, 0)");
    expect(PNL).toContain("'diamonds_paid'");
  });

  it('keeps the welcome spins apart from the paid game', () => {
    expect(PNL).toContain(
      'CASE WHEN s.is_welcome THEN COALESCE(s.prize_value_chips, 0) ELSE 0 END'
    );
    expect(PNL).toContain('CASE WHEN s.is_welcome THEN 0 ELSE s.spin_price_diamonds END');
    expect(PNL).toContain("'welcome_chips'");
  });

  it('excludes fixtures from all three games', () => {
    expect(PNL.match(/NOT COALESCE\((s|d|c)\.is_fixture, false\)/g)?.length).toBe(3);
  });

  it('excludes a crash round that has not decided yet', () => {
    expect(PNL).toContain("c.status <> 'open'");
  });

  it('never asks whether a player is a horse (CLAUDE.md 10.5)', () => {
    for (const [, sql] of READS) expect(sql).not.toMatch(/is_horse/);
  });
});

describe('the room says which ceiling is binding', () => {
  it('takes the cap from the same function the door uses', () => {
    expect(ROOM).toContain('public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_max_chips');
    expect(ROOM).toContain('public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_min_chips');
  });

  it('isolates the intake headroom by asking again with a bank nothing exhausts', () => {
    // Without this, a game held down by its own intake reads "thin" and the
    // console tells an owner to move chips they do not need to move.
    expect(ROOM).toContain(
      'v_cap_free := public.fn_diamond_game_cap_cents(cfg, pool, 1000000000000'
    );
    expect(ROOM).toContain("'capped_by_cover', v_cap_max < v_cap_free");
    expect(ROOM).toContain("'capped_by_intake', v_cap_free < cfg.max_multiplier_cents");
  });

  it('thin means the COVER is the binding one, never the intake', () => {
    expect(ROOM).toContain("WHEN v_cap_max < v_cap_free THEN 'thin'");
    expect(ROOM).not.toContain("WHEN v_cap_max < cfg.max_multiplier_cents THEN 'thin'");
  });

  it('states the wheel in its own terms, including the owner diamond side', () => {
    expect(ROOM).toContain("'top_chip_prize_chips'");
    expect(ROOM).toContain("'top_diamond_prize_diamonds'");
    expect(ROOM).toContain("'diamond_prize_covered', v_owner_dia >= v_top_dia");
  });
});

describe('who is playing counts the day the caps are counted on', () => {
  it('uses the same Chicago day the door uses', () => {
    expect(PLAYERS).toContain("AT TIME ZONE 'America/Chicago')::date");
    expect(inForce('fn_wheel_spin_core').sql).toContain("AT TIME ZONE 'America/Chicago')::date");
  });

  it('flags a player who has reached either ceiling', () => {
    expect(PLAYERS).toContain(
      "'at_spin_cap', COALESCE(v_spin_cap, 0) > 0 AND a.spins >= v_spin_cap"
    );
    expect(PLAYERS).toContain(
      "'at_round_cap', COALESCE(v_round_cap, 0) > 0 AND a.rounds >= v_round_cap"
    );
  });

  it('names a player through the platform helper rather than a local rule', () => {
    expect(PLAYERS).toContain('public.fn_player_display_name(a.user_id)');
  });
});

describe('one component, so the two consoles cannot drift apart', () => {
  const ui = src('src/components/club/DiamondGamesMoney.tsx');

  it('both operations pages render the same one', () => {
    for (const page of [
      'src/pages/club/ClubDiamondGamesOperationsPage.tsx',
      'src/pages/club/ClubWheelOperationsPage.tsx',
    ]) {
      expect(src(page)).toContain('<DiamondGamesMoney clubId={clubUuid} />');
    }
  });

  it('it is built on the painted chassis, not drawn', () => {
    expect(ui).toContain("from '../console/SpadeConsole'");
    expect(ui).not.toMatch(/border-radius|linear-gradient|box-shadow/);
  });

  it('and it says which games the cover is holding down, not just that one is', () => {
    expect(ui).toContain('g.capped_by_cover');
    expect(ui).toContain('The Cover Is Holding This One Down');
  });

  it('and it says when a game is held by its own intake, which needs nothing', () => {
    // Without this the operator sees a top win far under the ceiling and no
    // reason for it, which invites them to move chips that would change nothing.
    expect(ui).toContain('g.capped_by_intake && !g.capped_by_cover');
    expect(ui).toContain('Held By What It Has Taken In, Not By Your Cover. Nothing To Do');
  });

  it('never prints a real figure as zero, and never prints minus zero', () => {
    // compactChips floors the absolute value, which is right everywhere it is
    // already used and wrong for a P and L: the live console showed "0" for a
    // net of half a chip and would have shown "-0" for a loss of one. Under a
    // chip the figure is stated in diamonds, which are always whole.
    expect(ui).toContain('function money(');
    expect(ui).toContain('if (Math.abs(n) >= 1) return compactChips(n);');
    expect(ui).toContain('Math.round(n * perChip)');
    // and no money cell may go back to the flooring formatter
    const cells = ui.split('\n').filter((l) => l.includes('_chips') && l.includes('compactChips('));
    expect(cells).toEqual([]);
  });

  it('shows a refusal rather than an empty table that looks like no history', () => {
    expect(ui).toContain('[pnl, room, players].find((r) => r && !r.ok)?.error ?? null');
    expect(ui).toContain('sc-ink--red');
  });
});
