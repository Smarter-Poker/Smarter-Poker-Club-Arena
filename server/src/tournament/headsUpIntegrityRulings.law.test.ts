import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ═════════════════════════════════════════════════════════════════════════
 *  DAN'S PHASE 5 RULINGS ON HEADS-UP TOURNAMENT BEHAVIOUR (2026-09-01)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Four decisions were put to Dan at the close of Phase 5. Every one of them
 * turned out to describe what the engine ALREADY does - three because the
 * behaviour was built correctly, one because he had already ruled on it on
 * 2026-08-26 and the gate went in that day. Nothing needed changing.
 *
 * That is exactly when a rule is most fragile: it holds by accident of the
 * current code rather than by anything that would notice it changing. This
 * file is what notices. Each block quotes the ruling it protects.
 *
 * SCOPE. Dan: "Do not broaden any of these decisions beyond heads-up
 * tournament behavior without checking with me." Where the engine is already
 * STRICTER than the ruling (the run-it-twice and insurance gate covers every
 * tournament, not only heads-up, on his own earlier ruling), the pin records
 * the wider rule as it stands and says so, rather than narrowing it.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe("Dan's Phase 5 rulings on heads-up tournaments", () => {
  /**
   * RULING 4: "Insurance / run-it-twice: Disable both in heads-up
   * tournaments for now. Tournament outcomes should use one board and the
   * standard prize structure."
   *
   * Already true, and wider: Dan 2026-08-26, quoted in the engine, "run it
   * twice or 3 times is a cash game only area. it should never be in MTT,
   * SPINS OR HEADS UP." Both features are refused on ANY tournament table.
   * Live on 2026-09-01: of 2,127 duel tables and 5,527 spin tables created in
   * two days, zero had either feature enabled.
   */
  it('refuses run-it-twice and insurance on every tournament table', () => {
    const src = read('src/engine/ServerTableEngineBase.ts');

    const gate = src.slice(
      src.indexOf('const ritIsTournament ='),
      src.indexOf('// SEQUENCING 2026-08-26')
    );
    expect(gate).toContain('!!this.tableInfo.tournament_id');
    expect(gate).toContain("this.tableInfo.game_type === 'tournament'");
    // RIT requires NOT a tournament.
    expect(gate).toMatch(/const ritEnabled =\s*\n?\s*!ritIsTournament &&/);
    // Insurance requires NOT a tournament.
    expect(gate).toMatch(/const insuranceEnabled = .*&& !ritIsTournament;/);
  });

  /**
   * RULING 2: "Disconnect while all-in: Protect the hand. Once a player is
   * all-in and no further action is possible, disconnecting must not fold or
   * otherwise disadvantage that hand. The board and settlement should
   * complete normally."
   *
   * Two independent guards already give this, and both must stay. An all-in
   * seat is never handed a turn in the first place, and the mid-turn
   * disconnect handler returns before it can touch one.
   */
  it('never folds or penalises an all-in seat when its player disconnects', () => {
    const src = read('src/engine/ServerTableEngineTurns.ts');

    const handler = src.slice(
      src.indexOf('protected handlePlayerDisconnectedMidTurn'),
      src.indexOf('protected handlePlayerDisconnectedMidTurn') + 1500
    );
    expect(handler).toContain(
      'if (player.is_folded || player.is_all_in || player.is_sitting_out) return;'
    );

    // And the seat is not actionable to begin with, so there is no turn for a
    // disconnect countdown to expire against.
    expect(src).toContain('!player.is_all_in');
  });

  /**
   * RULING 3: "Heads-up disconnect while action remains: Do not pause the
   * tournament indefinitely. Preserve the existing disconnect
   * grace/countdown, then blind or time the player out under the normal
   * rules. No special permanent pause at two players."
   *
   * The pin is the ABSENCE of a two-player special case. If somebody adds one
   * later, this is the test that asks whether Dan changed his mind.
   */
  it('has no special pause when a tournament reaches two players', () => {
    const disconnect = read('src/engine/DisconnectEngine.ts');
    const turns = read('src/engine/ServerTableEngineTurns.ts');

    for (const src of [disconnect, turns]) {
      // No heads-up-specific branch in either file. The only permitted
      // mentions are prose in comments, which are stripped first.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      expect(code).not.toMatch(/headsUp|heads_up|isHeadsUp/i);
      expect(code).not.toMatch(/pauseTournament|tournamentPause/i);
    }

    // The normal countdown is still the mechanism, unchanged.
    expect(disconnect).toContain('disconnectTimeoutSeconds: 30');
    expect(disconnect).toContain('reconnectGraceSeconds: 5');
    expect(disconnect).toContain('maxConsecutiveTimeouts: 3');
  });

  /**
   * RULING 1: "Keep detection in signal-only mode for now. Do not auto-block
   * or cap legitimate play... High-confidence signals may go to manual
   * review, but must not automatically punish players."
   *
   * The duel repeat-pairing scan must never grow teeth by accident. It may
   * INSERT a signal and raise an incident; it may not touch a player, a seat,
   * a wallet, a registration or a tournament.
   */
  it('keeps the duel repeat-pairing scan signal-only', () => {
    const sql = read('../supabase/migrations/20260901180000_ca_duel_repeat_pairing_signal.sql');

    // The only write it performs is the signal row.
    const writes = sql.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+[a-z_.]+/gi) ?? [];
    const touched = writes.map((w) => w.replace(/\s+/g, ' ').toLowerCase());
    for (const w of touched) {
      expect(
        w.includes('ca_collusion_signals') || w.includes('ca_guard_inventory'),
        `the scan must not write ${w}`
      ).toBe(true);
    }
    expect(sql).not.toMatch(
      /\b(UPDATE|DELETE FROM)\s+public\.(tournament_players|table_seats|club_members|profiles|blacklists)/i
    );

    // And the calibration Dan approved is the one in the file.
    expect(sql).toContain('v_min_meetings   constant int     := 8;');
    expect(sql).toContain('v_min_win_share  constant numeric := 0.8;');
  });
});
