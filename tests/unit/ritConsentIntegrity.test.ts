import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunItTwiceEngine } from '../../server/src/engine/RunItTwiceEngine';
import type { RunItMode } from '../../server/src/engine/RunItTwiceEngine';
import type { DeadlineScheduler } from '../../server/src/engine/DeadlineScheduler';
import { sliceMethod } from '../helpers/sourceWindow';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUN IT TWICE — CONSENT INTEGRITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production hand #3046089, cash table d9d3c3b3-c113-4cb2-946c-ebd9867ccb30:
 *
 *   run_it_twice = true, allow_run_it_twice = true, run_it_twice_enabled =
 *   true, run_it_mode = 'none', insurance_enabled = true, game_type = 'cash',
 *   tournament_id = null.
 *
 * That hand dealt THREE boards and split a 1470 pot 971.27 / 485.63. Nobody at
 * the table was ever shown a run-it-twice prompt. Two defects produced it, and
 * this file pins both:
 *
 *  A. `getChosenRuns` fell back to `config.maxRuns ?? 2` whenever there was no
 *     RIT state for the table, and returned the seeded `chosenRuns` for a state
 *     that was merely OFFERED. Three boards is exactly `maxRuns`. A default
 *     that decides how to divide a pot has to fail towards the outcome nobody
 *     has to agree to, and that is ONE board.
 *
 *  B. `run_it_mode = 'none'` means the players decide, so `mandatoryRuns` must
 *     be 0 and the OFFER path must be taken.
 *
 * NOTE ON DEFECT B, corrected 2026-08-27. The first version of this file also
 * asserted that `insurance_enabled = true` switched run it twice off at that
 * table (FIX 92's config-layer mutual exclusion). That rule was RETIRED on
 * 2026-08-26 by Dan's leader-seat recording — "THE INSURANCE PART PICKED UP ON
 * THE TURN. AFTER THE RUN IT TWICE WAS DECLINED" — and a table may now run both
 * features. Exclusivity is per HAND, not per table, and it lives in
 * handleAllInRunout's `ritFirst` dispatch. The assertions below pin what
 * applyRunItTwiceConfig() actually computes today.
 *
 * Deliberately NOT tested here: any live money path. Nothing in this file
 * touches Supabase or a real table (CLAUDE.md 11.5).
 */

// Inert scheduler — no real timers, no open handles, no auto-decline firing
// underneath an assertion. Same pattern as the server-side consent suite.
function stubScheduler(): DeadlineScheduler {
  return {
    start() {},
    schedule() {},
    cancel() {},
  } as unknown as DeadlineScheduler;
}

const TABLE = 'd9d3c3b3-c113-4cb2-946c-ebd9867ccb30';

function mkEngine(maxRuns: 2 | 3 = 3, mode?: RunItMode) {
  const engine = new RunItTwiceEngine(undefined, stubScheduler());
  engine.configure(TABLE, {
    enabled: true,
    mode,
    autoDeclineTimeout: 25,
    maxRuns,
  });
  return engine;
}

describe('a missing consent record means ONE board, never the maximum', () => {
  it('returns 1 when no state exists for the table', () => {
    const engine = mkEngine(3);
    // Configured for up to three boards, and not one player has been asked.
    expect(engine.getState(TABLE)).toBeNull();
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });

  it('returns 1 for a table that was never configured at all', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    expect(engine.getChosenRuns('a-table-nobody-configured')).toBe(1);
  });

  it('returns 1 while the offer is still OPEN (status "offered")', () => {
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    expect(engine.getState(TABLE)?.status).toBe('offered');
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });

  it('returns 1 when the chooser has picked but nobody has accepted', () => {
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B', 'C'], 1470);
    engine.chooserDecides(TABLE, 'A', 3);
    expect(engine.getState(TABLE)?.chooserDecided).toBe(true);
    expect(engine.getState(TABLE)?.status).toBe('offered');
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });

  it('returns 1 when the offer was DECLINED', () => {
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    engine.chooserDecides(TABLE, 'A', 3);
    engine.decline(TABLE, 'B');
    expect(engine.getState(TABLE)?.status).toBe('declined');
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });

  it('returns 1 after endHand clears the offer, even mid-configuration', () => {
    // The exact shape of the original bug: a state that existed and no longer
    // does, on a table whose config still says maxRuns 3.
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    engine.chooserDecides(TABLE, 'A', 3);
    expect(engine.accept(TABLE, 'B')).toBe(true);
    expect(engine.getChosenRuns(TABLE)).toBe(3);

    engine.endHand(TABLE);
    expect(engine.isEnabled(TABLE)).toBe(true); // config survives the hand
    expect(engine.getChosenRuns(TABLE)).toBe(1); // consent does not
  });

  it('returns the chosen number ONLY after a real accepted + chooserDecided state', () => {
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B', 'C'], 1470);
    engine.chooserDecides(TABLE, 'A', 3);
    expect(engine.accept(TABLE, 'B')).toBe(false); // not unanimous yet
    expect(engine.getChosenRuns(TABLE)).toBe(1);

    expect(engine.accept(TABLE, 'C')).toBe(true); // unanimous
    const state = engine.getState(TABLE);
    expect(state?.status).toBe('accepted');
    expect(state?.chooserDecided).toBe(true);
    expect(engine.getChosenRuns(TABLE)).toBe(3);
  });

  it('the OFFER ceiling is a separate question from the consented count', () => {
    // rit_offer has to advertise how many boards may be ASKED for. Reading
    // that off getChosenRuns is what let the maximum become a default.
    const engine = mkEngine(3);
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    expect(engine.maxRunsAllowed(TABLE)).toBe(3);
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });
});

describe('mandatoryRuns reads run_it_mode and nothing else', () => {
  it("'none' leaves the decision to the players (0 = ask them)", () => {
    // The live value on the table that ran three boards unasked.
    expect(mkEngine(3, 'none').mandatoryRuns(TABLE)).toBe(0);
  });

  it('an absent mode is also 0 — additive by design', () => {
    expect(mkEngine(3).mandatoryRuns(TABLE)).toBe(0);
  });

  it("'player_choice' is 0 — the offer goes out", () => {
    expect(mkEngine(3, 'player_choice').mandatoryRuns(TABLE)).toBe(0);
  });

  it("'mandatory_twice' forces 2", () => {
    expect(mkEngine(3, 'mandatory_twice').mandatoryRuns(TABLE)).toBe(2);
  });

  it("'mandatory_three' forces 3", () => {
    expect(mkEngine(3, 'mandatory_three').mandatoryRuns(TABLE)).toBe(3);
  });

  it('a disabled table forces nothing, whatever the mode says', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    engine.configure(TABLE, {
      enabled: false,
      mode: 'mandatory_three',
      autoDeclineTimeout: 25,
      maxRuns: 3,
    });
    expect(engine.mandatoryRuns(TABLE)).toBe(0);
  });
});

/**
 * The config computation itself, lifted out of ServerTableEngineBase.start()
 * into applyRunItTwiceConfig() so it can run per hand instead of once per
 * process. This mirrors that function's rules against the RIT engine directly
 * — the ServerTableEngine constructor needs Supabase credentials, which a unit
 * test must not have.
 *
 * Kept LINE FOR LINE with applyRunItTwiceConfig(), including its return shape.
 * A local helper that quietly drifts from the function it mirrors is worse than
 * no test: it goes green while asserting the opposite of production, and the
 * next reader trusts it. That is exactly what happened to the block below —
 * this helper carried `ritEnabled && !insuranceEnabled` for a day after the
 * engine had dropped that term. The source-level pins at the end of this file
 * are the guard against it happening again.
 */
function configureFromTableRow(
  engine: RunItTwiceEngine,
  tableId: string,
  row: {
    run_it_twice?: boolean;
    allow_run_it_twice?: boolean;
    run_it_twice_enabled?: boolean;
    insurance_enabled?: boolean;
    run_it_mode?: string;
    tournament_id?: string | null;
    game_type?: string;
    max_players?: number;
  }
): { ritEffective: boolean; insuranceEnabled: boolean } {
  const ritIsTournament = !!row.tournament_id || row.game_type === 'tournament';
  // HEADS-UP TABLE GATE 2026-09-13: a two-seat table FORMAT never offers the
  // question (Dan 2026-08-26: "never ... HEADS UP"). Mirrors the engine's
  // HEADS_UP_SEATS (2) read of tableInfo.max_players.
  const ritIsHeadsUpTable = Number(row.max_players) > 0 && Number(row.max_players) <= 2;
  const ritEnabled =
    !ritIsTournament &&
    !ritIsHeadsUpTable &&
    (((row.run_it_twice ?? true) && (row.allow_run_it_twice ?? true)) ||
      (row.run_it_twice_enabled ?? false));
  // ALL-CASH INSURANCE 2026-08-26: insurance carries the same tournament gate
  // as RIT, because the ledger step behind it is cash-only.
  const insuranceEnabled = (row.insurance_enabled ?? false) && !ritIsTournament;
  // SEQUENCING 2026-08-26: no `&& !insuranceEnabled` here. Both features may be
  // live on one table; the ORDER is what keeps them exclusive, per hand.
  const ritEffective = ritEnabled;
  engine.configure(tableId, {
    enabled: ritEffective,
    autoDeclineTimeout: 25,
    maxRuns: 3,
  });
  return { ritEffective, insuranceEnabled };
}

describe('insurance no longer switches run it twice off — they are sequenced per hand', () => {
  it('insurance_enabled true leaves RIT ENABLED (the hand #3046089 row)', () => {
    // The retired FIX 92 rule made this `false`. Since 2026-08-26 both
    // features are live on such a table and the RIT question is asked first;
    // insurance engages only if that question resolves to a single run.
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      run_it_twice_enabled: true,
      insurance_enabled: true,
      run_it_mode: 'none',
      tournament_id: null,
      game_type: 'cash',
    });
    expect(engine.isEnabled(TABLE)).toBe(true);
    expect(cfg.ritEffective).toBe(true);
    expect(cfg.insuranceEnabled).toBe(true);
  });

  it('the same row without insurance is identical as far as RIT is concerned', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      run_it_twice_enabled: true,
      insurance_enabled: false,
      run_it_mode: 'none',
      tournament_id: null,
      game_type: 'cash',
    });
    expect(engine.isEnabled(TABLE)).toBe(true);
    expect(cfg.insuranceEnabled).toBe(false);
  });

  it('the user-written columns are what turns RIT off, not insurance', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: false,
      allow_run_it_twice: true,
      run_it_twice_enabled: false,
      insurance_enabled: false,
      game_type: 'cash',
    });
    expect(cfg.ritEffective).toBe(false);
    expect(engine.isEnabled(TABLE)).toBe(false);
  });

  it('a disabled table can never offer, and offers nothing if asked', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    configureFromTableRow(engine, TABLE, { run_it_twice: false, game_type: 'cash' });
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    expect(engine.getState(TABLE)).toBeNull();
    expect(engine.getChosenRuns(TABLE)).toBe(1);
  });

  it('a tournament table disables BOTH features, whatever the columns say', () => {
    // RIT is cash-only by product decision; insurance is cash-only because the
    // ledger step behind it is. A stray insurance_enabled on a tournament row
    // would move seat chips with no bank record behind them.
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      run_it_twice_enabled: true,
      insurance_enabled: true,
      game_type: 'tournament',
    });
    expect(engine.isEnabled(TABLE)).toBe(false);
    expect(cfg.ritEffective).toBe(false);
    expect(cfg.insuranceEnabled).toBe(false);
  });

  it('a heads-up TABLE (two seats) never offers run it twice, whatever the columns say', () => {
    // Dan 2026-08-26: "it should never be in MTT, SPINS OR HEADS UP." The
    // tournament gate covered the first two; every 2-seat table on the
    // platform is a tournament today, so the third held only by accident.
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      run_it_twice_enabled: true,
      insurance_enabled: true,
      tournament_id: null,
      game_type: 'cash',
      max_players: 2,
    });
    expect(engine.isEnabled(TABLE)).toBe(false);
    expect(cfg.ritEffective).toBe(false);
    // Insurance carries only the tournament gate; a heads-up cash table keeps it.
    expect(cfg.insuranceEnabled).toBe(true);
  });

  it('a two-way all-in on a full ring is NOT heads-up: six seats keep the question', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      tournament_id: null,
      game_type: 'cash',
      max_players: 6,
    });
    expect(engine.isEnabled(TABLE)).toBe(true);
    expect(cfg.ritEffective).toBe(true);
  });

  it('a tournament_id disables both even when game_type says cash', () => {
    const engine = new RunItTwiceEngine(undefined, stubScheduler());
    const cfg = configureFromTableRow(engine, TABLE, {
      run_it_twice: true,
      allow_run_it_twice: true,
      insurance_enabled: true,
      tournament_id: '11111111-1111-1111-1111-111111111111',
      game_type: 'cash',
    });
    expect(cfg.ritEffective).toBe(false);
    expect(cfg.insuranceEnabled).toBe(false);
  });
});

describe('the auto-decline is distinguishable from a player decline', () => {
  it('a timeout decline is labelled so a forwarder can announce it', () => {
    const seen: Array<Record<string, unknown>> = [];
    const engine = mkEngine(3);
    engine.addEventListener((e) => seen.push(e as unknown as Record<string, unknown>));
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    engine.decline(TABLE, 'B', 'timeout');
    const declined = seen.find((e) => e.type === 'RIT_DECLINED');
    expect(declined).toBeTruthy();
    expect(declined!.reason).toBe('timeout');
  });

  it('a player decline is labelled "player" and defaults that way', () => {
    const seen: Array<Record<string, unknown>> = [];
    const engine = mkEngine(3);
    engine.addEventListener((e) => seen.push(e as unknown as Record<string, unknown>));
    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    engine.decline(TABLE, 'B');
    const declined = seen.find((e) => e.type === 'RIT_DECLINED');
    expect(declined!.reason).toBe('player');
  });

  it('a registered listener runs alongside the constructor callback', () => {
    const ctor: string[] = [];
    const extra: string[] = [];
    const engine = new RunItTwiceEngine((e) => ctor.push(e.type), stubScheduler());
    engine.configure(TABLE, { enabled: true, autoDeclineTimeout: 25, maxRuns: 3 });
    const listener = (e: { type: string }) => extra.push(e.type);
    engine.addEventListener(listener);
    // Idempotent by identity: wiring on every hand must not multiply delivery.
    engine.addEventListener(listener);

    engine.offer(TABLE, `${TABLE}:1`, 'A', ['A', 'B'], 1470);
    expect(ctor).toEqual(['RIT_OFFERED']);
    expect(extra).toEqual(['RIT_OFFERED']);
  });
});

/**
 * Source-level pins for the engine-host wiring. These live in
 * ServerTableEngineRunout / ServerTableEngineBase, whose constructors need
 * Supabase credentials, so they are asserted the way the neighbouring
 * ritSingleRunIsAnnounced suite asserts its own wiring: against the source.
 */
describe('the engine host re-reads the config and announces every single run', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  const RUNOUT = read('../../server/src/engine/ServerTableEngineRunout.ts');
  const BASE = read('../../server/src/engine/ServerTableEngineBase.ts');

  it('the RIT config computation is a callable method, not inline in start()', () => {
    expect(BASE).toContain('protected applyRunItTwiceConfig()');
    expect(BASE).toContain('this.applyRunItTwiceConfig()');
  });

  /**
   * These two are the guard on the block above. The helper up there mirrors
   * applyRunItTwiceConfig by hand, so it can drift; these assert the real
   * lines, and they fail the moment somebody restores FIX 92's config-layer
   * exclusion instead of the per-hand sequencing that replaced it.
   */
  it('a heads-up table format is refused at configure time, by the seat count', () => {
    expect(BASE).toContain("import { HEADS_UP_SEATS } from '../config/headsUpSpec.js';");
    // Whitespace-insensitive: Prettier wraps this line at the width it likes.
    expect(BASE.replace(/\s+/g, ' ')).toContain(
      'const ritIsHeadsUpTable = Number(this.tableInfo.max_players) > 0 && Number(this.tableInfo.max_players) <= HEADS_UP_SEATS;'
    );
    expect(BASE).toContain('!ritIsTournament &&\n      !ritIsHeadsUpTable &&');
  });

  it('insurance does NOT switch RIT off at configure time', () => {
    expect(BASE).toContain('const ritEffective = ritEnabled;');
    expect(BASE).toContain(
      'const insuranceEnabled = (this.tableInfo.insurance_enabled ?? false) && !ritIsTournament;'
    );
  });

  it('the sequencing lives in the runout dispatch, and only there', () => {
    // ritFirst reads the RIT engine alone. If it ever grows an insurance term,
    // the two features are being excluded again at the wrong layer.
    expect(RUNOUT).toContain(
      'const ritFirst = this.runItTwiceEngine.isEnabled(this.tableId) && !doubleBoardHand;'
    );
    // Insurance is reached only when the RIT question is not being asked.
    expect(RUNOUT).toContain('if (!ritFirst && insuranceEnabled');
  });

  it('it is re-applied before every all-in decides whether to offer', () => {
    const head = sliceMethod(RUNOUT, 'protected handleAllInRunout(');
    expect(head).toContain('this.applyRunItTwiceConfig();');
    expect(head).toContain('this.wireRunItTwiceEvents();');
  });

  it('the offer advertises the ceiling, not the consented count', () => {
    expect(RUNOUT).toContain('maxRuns: this.runItTwiceEngine.maxRunsAllowed(this.tableId)');
  });

  it('every single-run fallback in the resolver announces itself', () => {
    expect(RUNOUT).toContain("emitRitSingleRun('no_consent_recorded')");
    expect(RUNOUT).toContain("emitRitSingleRun('deck_too_short')");
  });

  it('the short-deck fallback uses the PACED runout, not the instant one', () => {
    const block = RUNOUT.slice(
      RUNOUT.indexOf("emitRitSingleRun('deck_too_short')"),
      RUNOUT.indexOf("emitRitSingleRun('deck_too_short')") + 260
    );
    expect(block).toContain('pacedAllInRunout');
    expect(block).not.toContain('continueRunout');
  });

  it('the auto-decline is forwarded to the wire, and only that', () => {
    const fn = RUNOUT.slice(
      RUNOUT.indexOf('protected wireRunItTwiceEvents()'),
      RUNOUT.indexOf('protected wireRunItTwiceEvents()') + 1200
    );
    expect(fn).toContain("event.type !== 'RIT_DECLINED'");
    expect(fn).toContain("!== 'timeout'");
    expect(fn).toContain("emitRitSingleRun('no_agreement')");
    // 2026-09-13: a single silent seat is named; the collective line otherwise.
    expect(fn).toContain("emitRitSingleRun('no_answer', silent[0] as string)");
  });

  it('a chooser who accepts without a run count gets an actionable error', () => {
    expect(RUNOUT).toContain(
      "userId === state.chooserPlayerId && runs === undefined && response === 'accept'"
    );
    expect(RUNOUT).toContain("error: 'Chooser must send runs (1, 2 or 3), not accept'");
  });
});
