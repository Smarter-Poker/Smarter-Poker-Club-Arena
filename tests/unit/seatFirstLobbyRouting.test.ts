/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A SEAT-FIRST GAME IS ENTERED THROUGH ITS TABLE, NEVER THROUGH SIGN UP (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21, binding: "A PLAYER SITS DOWN AT A TABLE AND BUYS INTO THE
 * SPIN OR HEADS UP, LIKE A CASH GAME." The lobby card's Sit Down button was
 * wired to onRegister — the MTT Sign Up dialog — which charges the entry fee
 * with no seat attached and leaves the player a paid, seatless "Spectating"
 * entrant. The database now refuses that registration outright
 * (fn_register_for_tournament's seat-first guard, PR #1620), so the wrong
 * wiring had decayed from "silently takes money" into "dead-ends at a
 * cryptic toast" — still a dead end.
 *
 * Three layers, pinned separately so a regression in any one goes red:
 *   1. LobbyTable routes a seat-first card's Sit Down to onSpinJoin.
 *   2. ClubHomePage supplies onSpinJoin (spinQuickJoin — opens the table).
 *   3. handleRegister itself refuses seat-first rows and reroutes them, so
 *      any surface that regrows the old wiring lands on the right flow.
 *
 * Source-contract pins — the repo's pattern for guards inside components too
 * heavy to render in a unit test. If one fails, read the comment beside the
 * code it points at before "fixing" the test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('seat-first lobby routing', () => {
  const lobby = read('components/lobby/LobbyTable.tsx');
  const club = read('pages/ClubHomePage.tsx');

  it('LobbyTable knows the spinjoin action and derives the variant from the entry', () => {
    expect(lobby).toContain("which === 'spinjoin'");
    expect(lobby).toContain("ctx.onSpinJoin?.(e, e.kind === 'sng' ? 'sng' : 'spin')");
  });

  it("the seat-first card's Sit Down prefers spinjoin over register", () => {
    const branch = lobby.slice(
      lobby.indexOf("e.kind === 'spin' || e.kind === 'sng'"),
      lobby.indexOf('const registered = ctx.registeredIds.has(e.id)')
    );
    // The seat-first split must match fn_take_seat_and_buy_in: spin, or a
    // 2-seat sng. Multi-seat SNGs stay on the register flow.
    expect(branch).toContain(
      "e.kind === 'spin' || (e.kind === 'sng' && e.capacity > 0 && e.capacity <= 2)"
    );
    expect(branch).toContain("ctx.onSpinJoin ? 'spinjoin' : 'register'");
  });

  it('ClubHomePage supplies onSpinJoin through spinQuickJoin', () => {
    const ctx = club.slice(
      club.indexOf('const lobbyCtx = useMemo<LobbyRowContext>'),
      club.indexOf('onJoinTable: (e) => handleJoinTable(e.id)')
    );
    expect(ctx).toContain('onSpinJoin:');
    expect(ctx).toContain('spinQuickJoin(');
  });

  it('handleRegister refuses seat-first rows and reroutes them to spinQuickJoin', () => {
    const start = club.indexOf('const handleRegister = useCallback');
    const end = club.indexOf('registerMtt(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gate = club.slice(start, end);
    expect(gate).toContain('isSeatFirstTournament(t)');
    expect(gate).toContain('spinQuickJoin(');
  });

  it('every client live-table lookup goes through the canonical primary-table resolver', () => {
    // The DB's fn_tournament_primary_table (occupancy first, oldest
    // tie-break) is the one answer the engine also uses; the client sites
    // that used to ask for "newest non-closed" now delegate.
    const svc = read('services/TableService.ts');
    expect(svc).toContain("supabase.rpc('fn_tournament_primary_table'");
    expect(club).toContain('tableService.resolveTournamentLiveTable');
    const table = read('pages/TablePage.tsx');
    expect(table).toContain('tableService.resolveTournamentLiveTable');
  });
});
