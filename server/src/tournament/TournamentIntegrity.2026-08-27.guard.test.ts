/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOURCE GUARDS FOR THE 2026-08-27 TOURNAMENT AUDIT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Five of the six fixes live inside `start()`, `advanceBlindLevel()` and the
 * elimination sweep — hundreds of lines each, against live Supabase, and not
 * exercisable in a unit test. The ARITHMETIC was extracted into pure modules
 * with real tests (blindEscalation.test.ts, breakEligibility.test.ts); what is
 * left is the SHAPE, and these forbid the shapes that caused the incidents.
 *
 * Same convention as TournamentFixes.guard.test.ts and
 * SpinDrawIntegrity.guard.test.ts: comments are stripped first so a guard
 * cannot pass on a mention in prose. If a rule here is deliberately superseded,
 * delete the guard IN THE SAME COMMIT and say why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const BASE = strip(read('src/tournament/TournamentManagerBase.ts'));
const MANAGER = strip(read('src/tournament/TournamentManager.ts'));
const ELIM = strip(read('src/tournament/TournamentManagerEliminations.ts'));
const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');

const stripSqlComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

function newestFunction(name: string): string {
  let newest = '';
  for (const filename of fs
    .readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const source = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS, filename), 'utf8'));
    let start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    while (start >= 0) {
      const body = source.slice(start).match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/);
      if (!body || body.index == null) throw new Error(`${filename}: ${name} has no body`);
      const tag = body[1];
      const bodyStart = start + body.index + body[0].length;
      const end = source.indexOf(`${tag};`, bodyStart);
      if (end < 0) throw new Error(`${filename}: ${name} has an incomplete body`);
      newest = source.slice(start, end + tag.length + 1);
      start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, end + tag.length + 1);
    }
  }
  if (!newest) throw new Error(`${name} is missing`);
  return newest;
}

const CASH_PLACES = newestFunction('fn_settle_tournament_places');
const CASH_DEAL = newestFunction('fn_settle_tournament_final_table_deal');

// ═══════════════════════════════════════════════════════════════════════════
// A1 — blinds must not explode after a restart
// ═══════════════════════════════════════════════════════════════════════════
describe('A1: the cached blind structure is never mutated', () => {
  it('nothing pushes an invented level onto it', () => {
    // `blindStructure.push(autoLevel)` moved the very anchor the escalation
    // factor is measured from. After a restart that compounded: 32x, then
    // 1024x, then clamped at ten million within three levels.
    expect(BASE).not.toMatch(/blindStructure\.push\(/);
    expect(BASE).not.toMatch(/blind_structure\s*\)?\.push\(/);
  });

  it('the escalation factor is not computed inline any more', () => {
    // It lives in blindEscalation.ts, anchored to the PERSISTED length, and is
    // covered by real unit tests there.
    expect(BASE).not.toMatch(/escalationFactor\s*=\s*Math\.pow/);
    expect(BASE).toMatch(/escalatedBlindLevel\(/);
  });

  it('every level read goes through resolveBlindLevel, not a clamped index', () => {
    // `blindStructure[Math.min(currentLevel, length - 1)]` is what made the
    // break card, the lobby and new expansion tables show 750/1500 while the
    // felt played 12,000/24,000.
    expect(BASE).not.toMatch(/blindStructure\[\s*Math\.min\(/);
    expect(BASE).not.toMatch(/structureAtPause\[\s*Math\.min\(/);
    expect(MANAGER).not.toMatch(/blindStructure\[\s*\n?\s*Math\.min\(/);
    expect(BASE).toMatch(/protected resolveBlindLevel\(/);
  });

  it('the resume path resolves the level instead of indexing the array', () => {
    // 2026-08-31. resume() read `(tournament.blind_structure || [])[currentLevel]`
    // and fell back to `[0]`, so a tournament PAST THE END of its structure
    // resumed its level clock on LEVEL 1's duration — the one case
    // resolveBlindLevel exists to answer.
    //
    // It failed in the expensive direction. Most structures SHORTEN toward the
    // end (that is what makes a final table), so a 2-minute level resumed as a
    // 4-minute one and the blinds stalled for twice as long at exactly the
    // depth where blind speed decides the tournament. The staleness window
    // (`durationMs * 4`) was doubled by the same mistake. Measured over 14
    // days: 1,499 tournaments ran past their structure with varying level
    // lengths.
    //
    // Same defect as A1 above — a restart freezing blind escalation — which
    // had been fixed everywhere except here.
    const fn = sliceMethod(BASE, 'private async resumeLifecycle(');
    expect(fn).not.toMatch(/blind_structure\s*\|\|\s*\[\]\s*\)\s*\[\s*this\.currentLevel\s*\]/);
    expect(fn).toMatch(/this\.resolveBlindLevel\(\s*tournament\.blind_structure/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2 — a Spin never takes the :55 break
// ═══════════════════════════════════════════════════════════════════════════
describe('A2: the break gate is where the break starts, not only in the caller', () => {
  it('pauseForBreak refuses on its own', () => {
    const fn = sliceEnclosingBlock(BASE, 'async pauseForBreak(');
    expect(fn).toMatch(/await this\.breakApplies\(\)/);
  });

  it('breakApplies re-reads the row when the cache is not populated yet', () => {
    // A manager sits with running=true and tournamentCache=null from the top of
    // start() until the row lands, and everything that reads the cache alone
    // calls that manager an MTT.
    const fn = BASE.slice(BASE.indexOf('protected async breakApplies('));
    expect(fn).toMatch(/from\('tournaments'\)/);
    expect(fn).toMatch(/maybeSingle\(\)/);
  });

  it('the format rule is stated once and reused', () => {
    expect(BASE).toMatch(/mayTakeSynchronizedBreak\(/);
    const classify = sliceMethod(BASE, 'isMttOrXmtt(');
    expect(classify).toMatch(/isPersistedUnlimitedMtt\(this\.tournamentCache\)/);
    // The old hand-rolled copy inside isMttOrXmtt is gone.
    expect(BASE).not.toMatch(/type === 'SNG' \|\| type === 'SPIN'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A3 — the wheel is anchored to the third payment, and the hold is explicit
// ═══════════════════════════════════════════════════════════════════════════
describe('A3: the spin reveal', () => {
  it('is not stamped with Date.now() after the draw, settle, write and seating', () => {
    const reveal = sliceEnclosingBlock(BASE, 'revealIsSpin && revealMultiplier > 0');
    expect(reveal).not.toMatch(/const revealAt = Date\.now\(\)/);
    expect(reveal).toMatch(/this\.resolveSpinReveal\(\)/);
  });

  it('is stamped from the last buy-in debit, at the paid-seat gate', () => {
    expect(BASE).toMatch(/stampSpinRevealAnchor\(/);
    const stamp = sliceMethod(BASE, 'protected stampSpinRevealAnchor(');
    expect(stamp).toMatch(/SPIN_REVEAL\.LEAD_IN_MS/);
    expect(stamp).toMatch(/spinRevealToDealMs\(\)/);
  });

  it('exposes the hold to the client as an absolute instant', () => {
    const emit = sliceEnclosingBlock(BASE, "type: 'spin_reveal'");
    /* Both now carry `effectiveHold` (moved 2026-09-02 with the fix, §10.6).
       The comment beside hold_until in the engine calls it "the same number
       holdDealingUntil was just given, so it is the contract and not a
       description of one" - and it was not, because the engine was held to
       effectiveHold and the client was told holdUntil. This pins the contract
       the comment always claimed. */
    // The EARLY packet keeps announcing the planned hold on purpose: three
    // wheels are already turning on those numbers, and moving a shared moment
    // is worse than a slightly short budget (the client is allowed to finish
    // early). Its replay window still has to cover the real hold.
    expect(emit).toMatch(/hold_until:\s*holdUntil/);
    expect(emit).toMatch(/reveal_at:\s*revealAt/);

    // The MAIN packet is the contract: the number the client is told must BE
    // the number holdDealingUntil was given. It was not until 2026-09-02 -
    // the engine held to effectiveHold and told the client holdUntil.
    const main = sliceEnclosingBlock(BASE, "type: 'spin_reveal'", 1);
    expect(main).toMatch(/hold_until:\s*effectiveHold/);
    expect(main).toMatch(/replay_until:\s*effectiveHold/);
  });

  it('MEASURES the gap instead of letting it come off the wheel', () => {
    expect(BASE).toMatch(/spinRevealLagMs/);
    expect(BASE).toMatch(/spin_reveal_window_overrun/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — the first button
// ═══════════════════════════════════════════════════════════════════════════
describe('A4: the drawn first button', () => {
  it('is drawn with CryptoRandom, not Math.random', () => {
    // Every shuffle in this engine already goes through CryptoRandom. The first
    // button on a 3-handed hyper is a real positional edge.
    expect(BASE).not.toMatch(/Math\.random\(\)/);
    // The draw sits ABOVE the emit, so climb out of the object literal to the
    // block that computes the seat as well as publishing it.
    const draw = sliceEnclosingBlock(BASE, "type: 'spin_button'", 0, 2);
    expect(draw).toMatch(/secureRandomInt\(seats\.length\)/);
  });

  it('is persisted, because a restart before the first hand reverted it', () => {
    expect(BASE).toMatch(/first_button_seat/);
    expect(BASE).toMatch(/protected async restoreDrawnFirstButtons\(/);
  });

  it('is only re-applied to a table that has never dealt', () => {
    // Past the first hand a forced seat BEATS the live rotation, so re-applying
    // it would throw the button backwards and re-take the blinds.
    const fn = BASE.slice(BASE.indexOf('protected async restoreDrawnFirstButtons('));
    const body = fn;
    expect(body).toMatch(/from\('hand_history'\)/);
    expect(body).toMatch(/count:\s*'exact'/);
    expect(body).toMatch(/setFirstButtonSeat\(/);
    // An unreadable history is UNKNOWN: leave the live table alone.
    expect(body).toMatch(/\bcontinue;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A5 — a guarantee is funded, not declared
// ═══════════════════════════════════════════════════════════════════════════
describe('A5: overlays move real chips', () => {
  it('no engine write site computes its own guaranteed pool', () => {
    // `Math.max(pool, gtd)` written straight into prize_pool created the
    // overlay out of nothing: no treasury debit, no overlay row, and the
    // difference paid to real wallets. 2,823 events, 98,253.32 chips.
    expect(BASE).not.toMatch(/effectivePrizePool\(/);
  });

  it('live finish asks only for a terminal receipt', () => {
    const finish = sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>');
    expect(finish).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(finish).not.toMatch(/applyPrizeGuarantee|fn_apply_prize_guarantee/);
  });

  it.each([CASH_PLACES, CASH_DEAL])(
    'the cash authority funds before it derives any payout',
    (authority) => {
      const fund = authority.indexOf('public.fn_apply_prize_guarantee(');
      const journal = authority.indexOf("v_guarantee_result->>'overlay_journaled'", fund);
      const refresh = authority.indexOf('INTO v_t', journal);
      const floor = authority.indexOf('guaranteed_prize', refresh);
      const pricing = Math.min(
        ...[
          authority.indexOf('fn_ca_tournament_place_amounts', floor),
          authority.indexOf('v_total_chips', floor),
        ].filter((index) => index >= 0)
      );

      expect(fund).toBeGreaterThanOrEqual(0);
      expect(journal).toBeGreaterThan(fund);
      expect(refresh).toBeGreaterThan(journal);
      expect(floor).toBeGreaterThan(refresh);
      expect(pricing).toBeGreaterThan(floor);
    }
  );

  it('uses the refreshed funded pool rather than a number computed beside it', () => {
    expect(CASH_PLACES).toMatch(
      /v_guarantee_result->>'prize_pool'[\s\S]*?IS DISTINCT FROM v_t\.prize_pool[\s\S]*?RAISE EXCEPTION/
    );
    expect(CASH_PLACES).not.toMatch(/Math\.max\(/);
  });

  it('a refused or unjournaled overlay aborts the same transaction', () => {
    for (const authority of [CASH_PLACES, CASH_DEAL]) {
      expect(authority).toMatch(
        /v_guarantee_result := public\.fn_apply_prize_guarantee\([\s\S]*?overlay_journaled[\s\S]*?RAISE EXCEPTION/
      );
      expect(authority).not.toMatch(/EXCEPTION WHEN OTHERS/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A6 — the final table is one table
// ═══════════════════════════════════════════════════════════════════════════
describe('A6: a headcount is not a final table', () => {
  it('the shared predicate exists and fails closed on an unreadable layout', () => {
    const fn = BASE.slice(BASE.indexOf('protected async countLiveTablesWithPlayers('));
    const body = fn;
    expect(body).toMatch(/from\('tables'\)/);
    expect(body).toMatch(/is\('left_at',\s*null\)/);
    expect(body).toMatch(/return null/);
  });

  it('the final-table announcement requires exactly one live table', () => {
    const fn = MANAGER.slice(MANAGER.indexOf('protected async checkTableBalance('));
    const window = fn;
    expect(window).toMatch(/countLiveTablesWithPlayers\(\)/);
    expect(window).toMatch(/liveTables === 1/);
    // The bare count is no longer sufficient on its own.
    expect(window).not.toMatch(/<= finalTableSize\)\s*\{\s*this\.isFinalTable = true/);
  });

  it('the deal poll proves one authoritative occupied engine before settlement', () => {
    const check = sliceMethod(ELIM, 'protected async checkFinalTableDeal()');
    const authority = sliceMethod(ELIM, 'private async authoritativeFinalTableDealEngine()');
    const boundary = sliceMethod(ELIM, 'private async completeFinalTableDealAtBoundary(');
    const prove = check.indexOf('this.authoritativeFinalTableDealEngine()');
    const settle = check.indexOf('this.completeFinalTableDealAtBoundary(', prove);

    expect(authority).toMatch(/if \(tablesErr \|\| !tables\) return null/);
    expect(authority).toMatch(/if \(seatsErr \|\| !seats\) return null/);
    expect(authority).toMatch(/occupiedTableIds\.length !== 1/);
    expect(authority).toMatch(
      /!managerEngine \|\| !serverEngine \|\| managerEngine !== serverEngine/
    );
    expect(prove).toBeGreaterThanOrEqual(0);
    expect(settle).toBeGreaterThan(prove);
    expect(boundary.indexOf('parkForTerminalCloseout(')).toBeLessThan(
      boundary.indexOf('requestTournamentTerminalReceipt(')
    );
  });
});
