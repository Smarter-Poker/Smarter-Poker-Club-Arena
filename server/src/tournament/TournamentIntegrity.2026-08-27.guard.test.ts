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
    const fn = sliceMethod(BASE, 'async resume(');
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
    expect(BASE).toMatch(/isShortFormat\(/);
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

  it('all three sites call the funding RPC', () => {
    expect(BASE).toMatch(/protected async applyPrizeGuarantee\(/);
    expect(BASE).toMatch(/fn_apply_prize_guarantee/);
    expect((BASE.match(/this\.applyPrizeGuarantee\(/g) ?? []).length).toBe(3);
  });

  it('uses the pool the RPC returns rather than one computed beside it', () => {
    const fn = BASE.slice(BASE.indexOf('protected async applyPrizeGuarantee('));
    expect(fn).toMatch(/Number\(res\.prize_pool\)/);
    expect(fn).not.toMatch(/Math\.max\(/);
  });

  it('a failed funding call returns null rather than a locally invented pool', () => {
    const fn = BASE.slice(BASE.indexOf('protected async applyPrizeGuarantee('));
    expect(fn).toMatch(/prize_guarantee_unfunded/);
    expect(fn).toMatch(/return null/);
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

  it('the deal poll requires it too, before terminal settlement can run', () => {
    const fn = ELIM.slice(ELIM.indexOf('protected async checkFinalTableDeal('));
    const gate = fn.indexOf('countLiveTablesWithPlayers()');
    const deal = fn.indexOf('requestTournamentTerminalReceipt(');
    expect(gate).toBeGreaterThan(-1);
    expect(deal).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(deal);
    expect(sliceEnclosingBlock(fn, 'liveTables')).toMatch(/liveTables !== 1/);
  });
});
