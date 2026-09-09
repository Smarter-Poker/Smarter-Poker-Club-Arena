/**
 * BOMB POT GUARDS (2026-08-28) — source pins for the multi-board rules that
 * live at integration seams no harness drives end to end. Same pattern as
 * showdownSystem.test.ts: the pin names the exact line so the next refactor
 * that drops a guard fails here instead of in production.
 *
 * Spec references: Dan's Bomb Pot Rules + Architecture Specification §19
 * (Rabbit Hunt disabled on multi-board bomb pots; RIT suppressed) and §15
 * (the table must disclose bomb rules from the columns the engine plays by).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  sliceMethod,
  sliceEnclosingBlock,
  sliceCssRule,
  blankNonCode,
} from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('a multi-board bomb pot is never offered a rabbit hunt (spec §19)', () => {
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');

  it('the offer gate excludes multi-board hands like it excludes RIT', () => {
    expect(SETTLEMENT).toMatch(/multiBoardBomb\s*=\s*this\.handController\?\.isDoubleBoardActive/);
    expect(SETTLEMENT).toMatch(/!ranItTwice && !multiBoardBomb/);
  });

  it('the client draws no board-1 rabbit cards on boards 2 and 3', () => {
    const PAGE = read('src/pages/TablePage.tsx');
    // Board 2 and board 3 both mount CommunityCards with an EMPTY rabbit list.
    const board2 = PAGE.slice(PAGE.indexOf('className="community-area__board2"'));
    expect(board2).toMatch(/rabbitCards=\{\[\]\}/);
    const board3 = PAGE.slice(PAGE.indexOf('community-area__board3'));
    expect(board3).toMatch(/rabbitCards=\{\[\]\}/);
  });
});

describe('RIT and insurance stay suppressed on any multi-board hand (spec §14/§19)', () => {
  it('isDoubleBoardActive answers for two AND three boards', () => {
    const HC = read('server/src/engine/HandController.ts');
    const fn = HC.slice(HC.indexOf('public isDoubleBoardActive'));
    expect(fn).toMatch(/return this\.multiBoardActive;/);
  });
});

describe('the LIVE hand variant is the one seam (spec §10.1)', () => {
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const ENGINE = read('server/src/engine/ServerTableEngine.ts');
  const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');

  it('Base exposes activeHandVariant reading the live HandController', () => {
    expect(BASE).toMatch(
      /activeHandVariant\(\): string \{\s*return this\.handController\?\.getGameVariant\?\.\(\) \?\? this\.dealtGameVariant\(\);/
    );
  });

  it('the snapshot betting structure reads the HAND variant', () => {
    const fn = sliceMethod(ENGINE, 'private bettingStructureFields');
    expect(fn).toMatch(/this\.activeHandVariant\(\)/);
    expect(fn).not.toMatch(/tableInfo\?\.game_variant/);
  });

  it('the legal-action pot-limit clamp reads the HAND variant', () => {
    const window = sliceEnclosingBlock(TURNS, 'const structure = bettingStructureFor(variant)');
    expect(window).toMatch(/this\.activeHandVariant\(\)/);
  });

  it('horses evaluate the HAND variant', () => {
    expect(TURNS).toMatch(/gameVariant: \(this\.activeHandVariant\(\) \|\| 'nlh'\)/);
  });

  it('hand history records the variant the hand was DEALT as', () => {
    expect(SETTLEMENT).toMatch(
      /gameVariant: snap\.variant \|\| tableInfo\.game_variant \|\| 'nlh'/
    );
  });

  it('an override that cannot cover the seats yields to the table variant', () => {
    // 9-handed PLO6 needs 54 hole cards from 52. The override must yield,
    // never the deal.
    expect(DEALING).toMatch(/holeNeed <= deckSizeFor\(resolved\)/);
  });
});

describe('BOMB POT MAX (2026-08-28) — the round-4 seams', () => {
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const RUNOUT = read('server/src/engine/ServerTableEngineRunout.ts');
  const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
  const HAND_HISTORY = read('server/src/services/supabase/handHistory.ts');
  const HORSE = read('server/src/engine/HorseLogic.ts');
  const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');

  it('the manual trigger is claimed ATOMICALLY and fails CLOSED', () => {
    // A bomb that fires twice is worse than one that arrives a hand late.
    //
    // 2026-08-29: this pinned a SELECT-then-UPDATE that no longer exists. The
    // invariant it guards is unchanged and the mechanism is stronger, so the
    // pin moves with it rather than being deleted.
    //
    // What was wrong: two sequential awaits on the hand-start critical path of
    // every bomb-enabled table on every non-bomb hand, and — worse — a
    // check-then-act with no predicate on the write. Two engines overlapping
    // during a shard handoff or a restart could both read `true` and both
    // fire, which is the double bomb the old comment said it was preventing.
    //
    // A conditional UPDATE is both halves at once: exactly one caller gets a
    // row back and that caller owns the bomb.
    expect(DEALING.indexOf('bomb_pot_manual_pending: false')).toBeGreaterThan(-1);
    const window = sliceEnclosingBlock(DEALING, 'bomb_pot_manual_pending: false', 0, 2);
    // The predicate is the whole point — without it this is the old race.
    expect(window).toMatch(/\.eq\('bomb_pot_manual_pending', true\)/);
    // One statement, not two: no SELECT of the flag before the write.
    expect(window).not.toMatch(/\.select\('bomb_pot_manual_pending'\)/);
    // Fails closed: an error claims nothing and the bomb waits a hand.
    expect(window).toMatch(/if \(claimErr\)/);
    expect(window).toMatch(/deferring/);
    // And the claim only happens when the bomb could actually fire — claiming
    // below the min-players floor would consume the host's request and deal a
    // normal hand, which is the one way an atomic claim can be worse than the
    // read it replaced.
    expect(DEALING).toMatch(/players\.length >= schedulerSettings\.minPlayers/);
  });

  it('the separate bomb button rewinds the regular rotation on bomb hands', () => {
    expect(DEALING).toMatch(/bomb_pot_button_policy \?\? 'regular'\) === 'separate'/);
    expect(DEALING).toMatch(/this\.lastButtonSeat = prevButtonSeat > 0 \? prevButtonSeat/);
  });

  it('scheduler state persists and is restored before the first hand', () => {
    expect(DEALING).toMatch(/this\.bombPotScheduler\.restoreState\(persistedState\)/);
    expect(DEALING).toMatch(/bomb_pot_sched_state: snapObj/);
  });

  it('multi-board all-in equity is COMPUTED per board, not suppressed', () => {
    expect(RUNOUT).toMatch(/if \(allInPlayers\.length >= 2\) \{/);
    expect(RUNOUT).not.toMatch(/allInPlayers\.length >= 2 && !doubleBoardHand/);
    expect(RUNOUT).toMatch(/perBoard\.reduce/);
    // RIT and insurance stay suppressed on multi-board hands.
    expect(RUNOUT).toMatch(/insuranceEngine\.isEnabled\(this\.tableId\) && !doubleBoardHand/);
  });

  it('horses average per-board equity on multi-board hands', () => {
    expect(HORSE).toMatch(/gs\.communityCards2/);
    expect(HORSE).toMatch(/equity = sum \/ boards\.length/);
    expect(TURNS).toMatch(/communityCards2: fullState\?\.communityCards2 \?\? \[\]/);
  });

  it('the award-unit ledger covers EVERY bomb hand, idempotently', () => {
    // Units now travel inside the same immutable request that commits the
    // hand, stacks, rake link, and projection outbox. There is no second
    // PostgREST upsert whose success can diverge from the hand receipt.
    expect(SETTLEMENT).toContain('const bombAwardUnits =');
    expect(SETTLEMENT).toContain('snap.bombPot && snap.perPotAwards.length > 0');
    expect(SETTLEMENT).toContain('snap.perPotAwards.map((a) => ({');
    expect(SETTLEMENT).toContain('bombAwardUnits,');
    const writer = sliceMethod(HAND_HISTORY, 'async function insertHandHistoryRow(');
    expect(writer).toContain('p_units: bombAwardUnits');
    expect(writer).toContain("supabase.rpc('fn_ca_commit_hand_settlement', payload)");
    expect(writer).not.toContain("from('bomb_pot_award_units').upsert");
  });

  it('a transient write failure retries the complete hand and cannot split its ledger', () => {
    const writer = sliceMethod(HAND_HISTORY, 'async function insertHandHistoryRow(');
    expect(writer).toMatch(
      /for \(let attempt = 0; attempt <= HAND_COMMIT_RETRY_DELAYS_MS\.length; attempt\+\+\)/
    );
    expect(writer.match(/const payload =/g)).toHaveLength(1);
    expect(writer).toContain("supabase.rpc('fn_ca_commit_hand_settlement', payload)");
    expect(writer).toContain('after ${HAND_COMMIT_RETRY_DELAYS_MS.length + 1} identical attempts');
    expect(SETTLEMENT).not.toContain('writeAwardUnits');
    expect(SETTLEMENT).not.toContain('BOMB_LEDGER_WRITE_ATTEMPTS');
  });

  it('a gap that still slips through is reported by reconciliation, not lost', () => {
    // The retry above makes a lost row unlikely; this makes a lost row VISIBLE.
    // Same shape CLAUDE.md section 11.5 settled on for seat-stack exits: a
    // guard that can REFUSE a settlement is worse than the thing it guards
    // against, so make the failure loud rather than impossible.
    const gaps = read('supabase/migrations/20260829_bomb_award_ledger_gaps_are_loud.sql');
    expect(gaps).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_bomb_pot_ledger_gaps/);
    // p_grace: the write is asynchronous by design, so a hand that settled
    // seconds ago legitimately has no rows yet and is NOT a gap.
    expect(gaps).toMatch(/p_grace interval\s+DEFAULT '10 minutes'::interval/);
    // Named roles, not just PUBLIC — REVOKE ... FROM PUBLIC does not remove
    // Supabase's own anon grant (fn_request_manual_bomb_pot kept one that way).
    expect(gaps).toMatch(/FROM PUBLIC, anon, authenticated;/);

    const nightly = read('supabase/migrations/20260829_reconcile_reports_bomb_award_gaps.sql');
    expect(nightly).toMatch(
      /'bomb_award_ledger_gap', NULL, g\.net_winnings, g\.ledger_total, 'critical'/
    );
    expect(nightly).toMatch(/FROM public\.fn_bomb_pot_ledger_gaps\('1 day'::interval\) g/);
    // The CHECK constraint must accept the value the reporter emits, or the
    // whole nightly run aborts on the first gap it finds.
    expect(gaps).toMatch(/'bomb_award_ledger_gap'::text\]\)\);/);
  });
});

describe('ROUND 5 (2026-08-28) — clone hygiene and manual-trigger ordering', () => {
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const PAGE = read('src/pages/TablePage.tsx');

  it('the scheduler decides BEFORE the manual flag is read', () => {
    // Cost (no extra round trip on hands that are already bombs) AND intent
    // (a host's extra-bomb request is not swallowed by a scheduled one).
    const schedIdx = DEALING.indexOf('let decision: BombPotDecision = this.bombPotScheduler');
    const manualIdx = DEALING.indexOf('bomb_pot_manual_pending');
    expect(schedIdx).toBeGreaterThan(-1);
    expect(manualIdx).toBeGreaterThan(schedIdx);
    // 2026-08-29: the condition gained the min-players gate and Prettier broke
    // it across lines, so a single-line regex could no longer match code that
    // had not changed in substance. The invariant here is ORDER, so assert the
    // order — each clause after the scheduler's decision and before the claim
    // that acts on it. No window, fixed-size or otherwise: three indexes and
    // the relations between them, which no amount of reformatting can move.
    const claimIdx = DEALING.indexOf(".eq('bomb_pot_manual_pending', true)");
    expect(claimIdx).toBeGreaterThan(-1);
    for (const clause of [
      '!decision.isBombPot',
      'this.tableInfo.bomb_pot_enabled === true',
      'players.length >= schedulerSettings.minPlayers',
    ]) {
      const at = DEALING.indexOf(clause);
      expect(at, `${clause} is missing from the manual-trigger gate`).toBeGreaterThan(schedIdx);
      expect(at, `${clause} must be read before the claim`).toBeLessThan(claimIdx);
    }
  });

  it('a bomb hand carries no straddle into HandConfig', () => {
    // The straddle block runs BEFORE the bomb decision, so straddleResults was
    // populated on every bomb hand of a straddle-enabled table and handed
    // straight into the config. No money moved — HandController reads
    // config.straddles only in postBlinds and in the preflop-first-action
    // branch, and a bomb hand reaches neither — but a config asserting
    // straddles nobody posted is a trap for the next reader of either branch.
    expect(DEALING).toMatch(
      /straddles:\s*bombPotConfig \|\| straddleResults\.length === 0 \? undefined : straddleResults/
    );
  });

  it('a voided bomb hand still dismisses the overlay', () => {
    // BOMB_POT_COMPLETED is emitted after every HAND_COMPLETE by
    // HandController — four paths, all covered. The 10-minute safety timer is
    // the fifth exit and the only one that tears the hand down from OUTSIDE
    // the controller, so nothing emitted it and the overlay stayed on screen
    // over a table that had already started the next hand.
    const window = sliceEnclosingBlock(DEALING, 'Hand ${handNumber} timed out', 0, 2);
    expect(window).toMatch(/BOMB_POT_COMPLETED/);
    expect(window).toMatch(/this\.currentHandBombPot/);
  });

  it('a swept multi-board pot is announced with sound, not in silence', () => {
    // Bounded by the block that encloses the banner call, never a byte count
    // (tests/helpers/sourceWindow — a fixed window drifts off the code it
    // guards the moment a comment is added above it).
    const window = sliceEnclosingBlock(PAGE, 'setScoopBanner({');
    expect(window).toMatch(/soundService\.isEnabled\(\) && ambientSoundsAllowedRef\.current/);
    expect(window).toMatch(/playBigWin\(\)/);
  });

  it('the clone migration resets bomb LIVE state and keeps bomb CONFIG', () => {
    const sql = read('supabase/migrations/20260828_clone_never_inherits_bomb_scheduler_state.sql');
    // The three engine-written columns are reset...
    expect(sql).toMatch(/'bomb_pot_sched_state',\s*NULL/);
    expect(sql).toMatch(/'bomb_pot_next_due_at',\s*NULL/);
    expect(sql).toMatch(/'bomb_pot_manual_pending', false/);
    // ...and the host's CONFIG is deliberately left to travel with the
    // template, which is the entire point of a template.
    expect(sql).not.toMatch(/'bomb_pot_board_count',\s*NULL/);
    expect(sql).not.toMatch(/'bomb_pot_trigger_mode',\s*NULL/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ALL-IN RUNOUT IS READ, NOT RACED (Dan 2026-08-28, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "ONLY SHOW THE EQUITY AFTER THE FLOP TURN OR RIVER IS DISPLAYED, NOT
 *  BEFORE, NOT DURING ONLY AFTER IT LANDS. AND THAT YOU WAIT ONE FULL SECOND
 *  BEFORE PUTTING OUT THE NEXT STREET EACH TIME. (AND EVERY TIME)"
 *
 * The reveal gate itself (allInStreetRevealMs) shipped separately the same
 * day. These pins exist so it cannot be quietly undone: the failure mode is
 * SILENT — move the equity broadcast back above the sleep and nothing errors,
 * the numbers simply start moving over cards still in the air again. Both
 * dealing paths are pinned, because both deal streets.
 */
describe('all-in equity lands AFTER the street, and every street gets its second', () => {
  const RUNOUT = read('server/src/engine/ServerTableEngineRunout.ts');
  const SPEC = read('server/src/config/handCompletionSpec.ts');

  it('the reveal gate is a shared spec constant, long enough to see a flop', () => {
    const reveal = Number(SPEC.match(/ALL_IN_STREET_REVEAL_MS:\s*(\d+)/)![1]);
    // The flop is the slowest street to land on the client (ccFlopLand 0.3s
    // then ccFlopFanOpen 0.5s at a 0.75s delay => ~1.25s).
    expect(reveal).toBeGreaterThanOrEqual(1250);
    expect(RUNOUT).toMatch(/allInStreetRevealMs = HAND_COMPLETION\.ALL_IN_STREET_REVEAL_MS/);
  });

  it('the paced runout waits for the card to be SEEN before broadcasting equity', () => {
    const loop = sliceEnclosingBlock(RUNOUT, 'const result = controller.dealNextStreet()');
    const deal = loop.indexOf('dealNextStreet()');
    const gate = loop.indexOf('allInStreetRevealMs');
    const equity = loop.indexOf('broadcastAllInEquity(');
    expect(deal).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(deal);
    expect(equity).toBeGreaterThan(gate);
  });

  it('the insurance per-street flow obeys the same order', () => {
    const fn = sliceMethod(RUNOUT, 'protected async dealNextInsuranceStreet');
    const deal = fn.indexOf('dealNextStreet()');
    const gate = fn.indexOf('allInStreetRevealMs');
    const equity = fn.indexOf('broadcastAllInEquity(');
    expect(gate).toBeGreaterThan(deal);
    expect(equity).toBeGreaterThan(gate);
  });

  it('a full second at least separates the streets, after the numbers are readable', () => {
    const pause = Number(RUNOUT.match(/allInStreetPauseMs = (\d+)/)![1]);
    expect(pause).toBeGreaterThanOrEqual(1000); // "ONE FULL SECOND ... EVERY TIME"
    const loop = sliceEnclosingBlock(RUNOUT, 'const result = controller.dealNextStreet()');
    // The gap is taken AFTER the equity broadcast, not instead of it.
    expect(loop.indexOf('allInStreetPauseMs')).toBeGreaterThan(
      loop.indexOf('broadcastAllInEquity(')
    );
  });

  it('per-board equity is priced in parallel, not one await at a time', () => {
    // This computation sits between the reveal gate and the percentages
    // appearing, so a serial loop pushes the numbers further from the card.
    const fn = sliceMethod(RUNOUT, 'protected async broadcastAllInEquity');
    expect(fn).toMatch(/await Promise\.all\(/);
    expect(fn).not.toMatch(/for \(const b of allBoards\) \{\s*perBoard\.push\(\s*await/);
  });
});

describe('the table page reads bomb rules from the COLUMNS (spec §15.2)', () => {
  const PAGE = read('src/pages/TablePage.tsx');

  it('the bootstrap select fetches the canonical bomb columns', () => {
    expect(PAGE).toMatch(
      /straddle_enabled, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds/
    );
  });

  it('bombPotRules prefers the row columns over the settings blob', () => {
    // All live tables carry settings = {}; reading the blob alone is the bug
    // that kept the Game Rules bomb section dark on every table.
    expect(PAGE).toMatch(
      /table\.bomb_pot_enabled === true \|\| settings\.bomb_pot_enabled === true/
    );
  });

  it('the timed felt clock counts down to the engine due timestamp', () => {
    expect(PAGE).toMatch(/bomb_pot_next_at|bombPotNextAt/);
    expect(PAGE).toMatch(/bombClockLabel/);
  });
});

/**
 * ROUND 7 (2026-08-29) — the audit sweep.
 *
 * Every pin below is a defect that shipped and was found by reading the whole
 * feature, server and client, line by line. None of them was visible from a
 * failing test, which is why they are pinned here now.
 */
describe('ROUND 7 (2026-08-29) — the audit sweep', () => {
  const SCHED = read('server/src/engine/BombPotScheduler.ts');
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const HC = read('server/src/engine/HandController.ts');
  const RUNOUT = read('server/src/engine/ServerTableEngineRunout.ts');
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const PAGE = read('src/pages/TablePage.tsx');
  const MODAL = read('src/components/table/GameRulesModal.tsx');
  const OVERLAY = read('src/components/table/BombPotOverlay.tsx');
  const CSS = read('src/pages/TablePage.css');

  it('a button that has not moved has not completed an orbit', () => {
    // THE RUNAWAY. buttonCrossedAnchor returned true when from === to, on the
    // reasoning that "a single seat dealt around" completes an orbit every
    // hand — a case that cannot occur, because a hand needs two players and
    // Dealing forces the button across whenever players.length > 2.
    //
    // What DOES produce from === to is the separate bomb button, which rewinds
    // the regular rotation on every bomb hand by design. So once_per_orbit
    // plus a separate button — and once_per_orbit is what the first host
    // preset selects — armed the token again on the very next hand: a forced
    // ante on EVERY hand, blinds that never post, and a regular button frozen
    // on one seat for the life of the table.
    const fn = sliceMethod(SCHED, 'private buttonCrossedAnchor');
    expect(fn).toMatch(/if \(from === to\) \{[\s\S]*?return false;/);
    expect(fn).not.toMatch(/if \(from === to\) \{[\s\S]*?return true;/);
  });

  it('once_per_orbit counts down on the felt like every other mode', () => {
    // handsUntilDue returned null for every mode but every_n_hands, and the
    // token is set and consumed inside one noteHandStart call — so the pill
    // never rendered and an orbit-mode table gave the player no warning at
    // all before a forced ante. An orbit is one hand per player dealt in;
    // both terms are measured, not guessed at from seat numbering.
    const fn = sliceMethod(SCHED, 'handsUntilDue(s: BombPotSchedulerSettings)');
    expect(fn).toMatch(/once_per_orbit/);
    expect(fn).toMatch(/this\.lastDealtInCount - this\.handsSinceAnchor/);
    // Persisted with the rest of the scheduler, or a deploy blanks the pill
    // for a whole orbit.
    expect(SCHED).toMatch(/o: this\.handsSinceAnchor/);
    expect(SCHED).toMatch(/n: this\.lastDealtInCount/);
  });

  it('the bomb ante is rounded to the cent BEFORE anybody is charged', () => {
    // The only forced-money path in the engine that did not round. The ante
    // multiplier steps by 0.5, so at micro stakes the product is a fraction of
    // a cent; snapChips then rounds each stack independently of state.pot and
    // the table stops conserving chips. Even at legal multiples the raw float
    // (0.1 * 3 = 0.30000000000000004) escaped into the actions log and into
    // hand_history.bomb_pot.ante_amount.
    const fn = sliceMethod(HC, 'private postBombPotAntes');
    expect(fn).toMatch(/Math\.round\(\s*\(bombPot\.anteFixed/);
    expect(fn).toMatch(/const actualAnte = Math\.round\(Math\.min\(anteAmount, player\.stack\)/);
    // And the deck size comes from VariantRules, not a sixth local literal.
    expect(fn).toMatch(/deckSizeFor\(this\.config\.gameVariant\)/);
    // blankNonCode: a negative assertion must read CODE. The comment above this
    // line quotes the literal it forbids, and without stripping comments the
    // pin fails on its own explanation of why it exists.
    expect(blankNonCode(fn)).not.toMatch(/=== .{0,14} \? 36 : 52/);
  });

  it('insurance and the RIT chooser read the HAND variant, not the table', () => {
    // Insurance is suppressed only on MULTI-board bombs. A single-board bomb
    // with a variant override is fully eligible, and both the leader election
    // and the pricing ran on tableInfo.game_variant — a Hold'em evaluator on
    // four-card holdings, and a contract priced as though the extra cards did
    // not exist. Insurance premiums and payouts are real money.
    // Negative assertions read CODE only — the comments in this file and in
    // Runout both quote the lines they replaced.
    const code = blankNonCode(RUNOUT);
    expect(code).not.toMatch(/const variant = this\.tableInfo\?\.game_variant/);
    expect(code).toMatch(/const variant = this\.activeHandVariant\(\);/);
    expect(code).not.toMatch(/this\.tableInfo\?\.game_variant ===/);
  });

  it('every equity broadcast prices every live board', () => {
    // dealNextStreet fills boards 2/3 in lockstep but returns board 1 alone,
    // so the three broadcasts AFTER the first had nothing to pass and fell
    // back to single-board pricing. A multi-board bomb showed correct averaged
    // percentages at the all-in and then wrong ones for the flop, turn and
    // river — drifting further from the truth as the hand got more dramatic.
    expect(RUNOUT).toMatch(/protected liveExtraBoards\(\)/);
    const calls = RUNOUT.match(/broadcastAllInEquity\(\s*allInPlayers,[\s\S]*?\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call, `an equity broadcast still prices board 1 only: ${call}`).toMatch(
        /liveExtraBoards\(\)/
      );
    }
  });

  it('the announce window is enforced by the ENGINE, not by the browser', () => {
    // The host's "keep the clock quiet until the bomb is close" setting was
    // read into tableInfo and never used: the snapshot published the exact due
    // timestamp to every player on every broadcast, and only the client's
    // render honoured it. Anyone reading the websocket had a number the
    // players looking at the felt did not — on a table with a forced ante.
    const fn = sliceMethod(BASE, 'protected bombPotSnapshotFields()');
    expect(fn).toMatch(/bomb_pot_announce_seconds/);
    expect(fn).toMatch(/bomb_pot_next_at: withheld \? null : dueAt/);
  });

  it('the bomb button obeys the new-player rule the regular button obeys', () => {
    // Dan, binding: "NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN."
    // buttonRoster exists to enforce it; the bomb rotation was using the raw
    // seat list, so a player on their first ever hand here could take the
    // button — which sets postflop action order and odd-chip allocation.
    const window = sliceEnclosingBlock(DEALING, 'this.bombButtonSeat = bombSeat;', 0, 2);
    expect(window).toMatch(/this\.getNextSeat\(this\.bombButtonSeat, buttonRoster\)/);
    expect(window).not.toMatch(/this\.getNextSeat\(this\.bombButtonSeat, players\)/);
  });

  it('a variant override obeys the seat law, not just the deck', () => {
    // maxSeatsFor('plo5') is 9 by deck arithmetic, but PLO5 is 7-max and PLO6
    // is 6-max by Dan's ruling. Nine players passed the deck test and were
    // dealt nine-handed PLO5 — and 45 hole cards then left no room for the
    // three boards the host asked for, so the feature was silently downgraded
    // on a hand that should not have used the override at all.
    expect(DEALING).toMatch(/const seatMax = maxSeatsForVariant\(resolved\);/);
    expect(DEALING).toMatch(/holeNeed <= deckSizeFor\(resolved\) && players\.length <= seatMax/);
  });

  it('disabling bomb pots clears the PERSISTED token too', () => {
    // noteHandStart resets the in-memory scheduler when the schedule is off,
    // but the write was gated on `enabled` — so `{p: true}` stayed in the row.
    // Re-enable, restart, and restoreState detonated that stale token on the
    // first valid hand: exactly what "re-enabling starts a fresh schedule"
    // exists to prevent.
    expect(DEALING).toMatch(/const snapObj = enabled[\s\S]*?: null;/);
    expect(DEALING).not.toMatch(/if \(schedulerSettings\.enabled\) \{\s*const dueAt/);
  });

  it('the bomb button is persisted AFTER the hand that uses it is decided', () => {
    // The persistence block used to run before `if (decision.isBombPot)`, so
    // on a bomb hand it wrote the PREVIOUS bomb's button seat — the seat this
    // hand uses had not been chosen yet.
    const decideIdx = DEALING.indexOf('this.bombButtonSeat = bombSeat;');
    const persistIdx = DEALING.indexOf('b: this.bombButtonSeat ?? null');
    expect(decideIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(decideIdx);
  });

  it('the Table Info tab can actually be opened', () => {
    // One token. The button labelled `info` called setActiveTab('rules'), and
    // nothing anywhere set 'info' — so the entire tab was unreachable in
    // production: the bomb-pot disclosure block, and with it the ONLY control
    // that reaches the manual-bomb RPC. A club owner could not fire a manual
    // bomb pot at all.
    // Anchored on the tab's OWN active-class expression, which is unique and
    // is code rather than prose — 'Table Info' as a needle also appears in the
    // comment explaining this fix, and in this test's own explanation.
    const tab = sliceEnclosingBlock(
      MODAL,
      "activeTab === 'info' ? 'rules-modal__tab--active'",
      0,
      2
    );
    expect(tab).toMatch(/setActiveTab\('info'\)/);
    expect(blankNonCode(tab)).not.toMatch(/setActiveTab\('rules'\)/);
    // The content it reveals must still be gated on the same value.
    expect(MODAL).toMatch(/\{activeTab === 'info' && \(/);
  });

  it('the rules panel quotes the ante the engine actually charges', () => {
    // The config form writes bomb_pot_ante_multiplier in BOTH modes and the
    // engine prefers bomb_pot_ante_fixed, which the table never fetched — so a
    // "Fixed Ante 25" table was described here as "2x BB" while the lobby,
    // which does read the fixed column, said 25. Two surfaces disagreeing
    // about the price of a hand.
    expect(PAGE).toMatch(/bomb_pot_ante_fixed, bomb_pot_min_players, bomb_pot_button_policy/);
    expect(MODAL).toMatch(/\(bombPotRules\.anteFixed \?\? 0\) > 0/);
  });

  it('the scoop banner is anchored to the boards it celebrates', () => {
    // It only ever renders on a multi-board hand — the one case where the
    // stack is tall enough to reach a banner pinned at 21% of the felt — so
    // the celebration for the biggest moment in the feature covered the board
    // that proved it. Anchored to .community-area, the collision is impossible
    // rather than unlikely, for one, two or three boards at any width.
    // sliceCssRule stops at the first `}`, and this rule opens with a comment
    // block containing braces, so bound it by structure on BLANKED source and
    // read the declarations from there.
    const rule = sliceCssRule(blankNonCode(CSS), '.bomb-scoop-banner {');
    expect(rule).toMatch(/top: 100%/);
    expect(rule).not.toMatch(/top: 21%/);
    // And reduced motion collapses the motion, never the meaning (§10.6): the
    // global 1ms rule does that; `animation: none` would strand it mid-thought.
    expect(blankNonCode(CSS)).not.toMatch(/\.bomb-scoop-banner \{\s*animation: none;/);
  });

  it('a forced ante is announced in words, not only in motion', () => {
    // The overlay is aria-hidden and should be — but every WORD of the event
    // lived inside it, so a screen-reader player was charged a forced ante
    // with no announcement of any kind (§10.6: reduced motion collapses the
    // motion, never the meaning; the same applies when it is hidden).
    expect(OVERLAY).toMatch(/role="status" aria-live="assertive"/);
    expect(OVERLAY).toMatch(/Everyone Antes \$\{anteAmount\.toLocaleString\(\)\}/);
  });

  it('urgency is not the steady state on a bomb-pot-only table', () => {
    // bomb_pot_only reports 1 hand until due forever, so the "next hand is the
    // bomb" pulse ran for the whole session on the one table where that fact
    // is ordinary — and stopped meaning anything everywhere else by
    // association.
    //
    // PIN MOVED 2026-09-05. The suppression used to be a `!== 'bomb_pot_only'`
    // conjunct inside the pill's className ternary. The pill was split in two
    // (a masthead line for every countdown state, a small marker on the board
    // for the bomb hand) and the text is now decided once, in `bombPotBadge`,
    // as an ordered ladder. Same guarantee, stated as ORDER: the bomb_pot_only
    // branch returns before any branch that can produce the pulsing 'next'
    // state, so that state is unreachable on such a table.
    const ladder = PAGE.slice(
      PAGE.indexOf('const bombPotBadge = useMemo'),
      PAGE.indexOf('MANUAL_NEXT_HAND (spec §2.1/§15.3)')
    );
    expect(ladder).toMatch(
      /if \(bombPotRules\?\.triggerMode === 'bomb_pot_only'\)\s*return \{ text: `\$\{prefix\}BOMB POT ONLY`, state: 'eta' \};/
    );
    expect(ladder.indexOf("=== 'bomb_pot_only'")).toBeLessThan(ladder.indexOf("state: 'next'"));
  });
});

/**
 * ROUND 8 (2026-08-29) — the last of the open items.
 *
 * Everything the round-7 audit left on the table, plus the three things that
 * audit could not see because they were absences rather than defects: a host
 * with no way to edit a running table, a club owner with no bomb-pot report,
 * and a ledger with a hole nobody could fill.
 */
describe('ROUND 8 (2026-08-29) — the last of the open items', () => {
  const SCHED = read('server/src/engine/BombPotScheduler.ts');
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
  const PAGE = read('src/pages/TablePage.tsx');
  const APP = read('src/App.tsx');
  const CONFIG = read('src/pages/TableConfigPage.tsx');

  it('the bomb button WALKS the table instead of parking on one seat', () => {
    // The bomb fires when the button lands on the anchor, and the anchor was
    // re-set to that same seat — so one player held the button on every bomb
    // pot for the life of the table. A bomb pot posts no blinds, so the button
    // is the ONLY positional variable in it: that seat acted last on every
    // street of every bomb pot, at a table where everyone was forced to ante.
    // Read the whole file rather than slicing a method: 'noteHandStart(' also
    // appears in the module docblock, so a signature anchor picks up the prose
    // and every assertion below it passes or fails for the wrong reason.
    const code = blankNonCode(SCHED);
    expect(code).toMatch(/this\.anchorAdvancePending = true;/);
    // The anchor is taken from the hand AFTER the bomb, which is one dealt-in
    // seat further round.
    expect(code).toMatch(
      /if \(this\.anchorAdvancePending\) \{[\s\S]*?this\.orbitAnchorSeat = dealerSeat;/
    );
    // The consume branch must NOT re-anchor to the bomb hand's own seat. That
    // one line is the whole defect: it is what parked the button.
    expect(code).not.toMatch(
      /triggerMode === 'once_per_orbit'\) \{\s*this\.orbitAnchorSeat = dealerSeat;/
    );
    // Persisted, or a restart parks it for one more orbit.
    expect(SCHED).toMatch(/x: this\.anchorAdvancePending/);
  });

  it('the felt says WHY a promised bomb has not arrived', () => {
    // isPending() had no production caller: a due bomb waits for minPlayers and
    // the engine said nothing, so the pill read BOMB POT NEXT HAND and the
    // table dealt ordinary hands indefinitely with no explanation anywhere.
    const fn = sliceMethod(BASE, 'protected bombPotSnapshotFields()');
    expect(fn).toMatch(/this\.bombPotScheduler\.isPending\(\)/);
    expect(fn).toMatch(/bomb_pot_waiting_for: waitingFor/);
    expect(PAGE).toMatch(/BOMB POT WAITING FOR \$\{tableState\.bombPotWaitingFor\} PLAYERS/);
    // And it is not URGENT — the pulse means "next hand", and a bomb that is
    // waiting on players is not coming next hand. PIN MOVED 2026-09-05 with
    // the one above: the guard is the ladder's order now, not a conjunct.
    const ladder = PAGE.slice(
      PAGE.indexOf('const bombPotBadge = useMemo'),
      PAGE.indexOf('MANUAL_NEXT_HAND (spec §2.1/§15.3)')
    );
    expect(ladder).toMatch(/if \(tableState\.bombPotWaitingFor != null\)/);
    expect(ladder.indexOf('bombPotWaitingFor != null')).toBeLessThan(
      ladder.indexOf("state: 'next'")
    );
  });

  it('the manual bomb is PUSHED, not polled every hand', () => {
    // One round trip at the top of every hand on every bomb table, forever,
    // for a flag that is false essentially always. The RPC broadcasts instead.
    expect(BASE).toMatch(/protected subscribeManualBomb\(\)/);
    // PIN MOVED 2026-09-06. The broadcast used to be heard on a channel named
    // `table:<id>`, opened PER TABLE. One engine holds one Realtime socket and
    // a socket caps at 100 channels, so 76 bomb tables plus one channel per
    // live tournament put the engine permanently over the cap: 123,219
    // ChannelRateLimitReached errors in 24 hours, and past the cap the joins
    // did not exist at all - so the tables this test was protecting were the
    // ones NOT listening. It is one shared channel now, dispatched by
    // table_id, and the event name lives with it.
    const BUS = read('server/src/services/BombRequestBus.ts');
    expect(BUS).toMatch(/BOMB_REQUEST_EVENT = 'bomb_pot_manual_requested'/);
    expect(BUS).toMatch(/BOMB_REQUEST_TOPIC = 'engine:bomb-requests'/);
    expect(BASE).toMatch(/subscribeBombRequests\(this\.tableId/);
    // Exactly one shared channel: a regression to per-table would reintroduce
    // the cap breach, so the bus must never build a topic from a table id.
    expect(BUS).not.toMatch(/channel\(`table:/);
    // The poll is DEMOTED, not deleted — a broadcast is best-effort and an
    // engine that restarted between the click and the hand never hears it, so
    // the throttled refresh (already happening) latches the column.
    expect(BASE).toMatch(/bomb_pot_announce_seconds, bomb_pot_manual_pending'/);
    // And the per-hand claim only runs when something is actually armed.
    expect(DEALING).toMatch(/this\.manualBombPushed &&/);
    // Closed with the engine that opened it.
    expect(BASE).toMatch(/this\.unsubscribeManualBomb\(\);/);
  });

  it('the write-only column is no longer written', () => {
    // `double_board` is true on 0 of 97,944 rows despite being written on every
    // double-board table ever created, because nothing has ever read it. The
    // lobby reads the settings blob; the engine reads bomb_pot_double_board.
    // 2026-09-04 (Operation Table Stakes, Slice 1): the cash writer is
    // fn_cash_game_create in SQL; the page builds no tables row any more.
    expect(blankNonCode(CONFIG)).not.toMatch(/^\s*double_board:/m);
    const CREATE_SQL = read('supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql');
    const insert = CREATE_SQL.slice(
      CREATE_SQL.indexOf('INSERT INTO public.tables ('),
      CREATE_SQL.indexOf('RETURNING id INTO v_table_id')
    );
    expect(insert).not.toMatch(/\bdouble_board\b/);
    // Its canonical sibling is still written — that one has readers — from
    // the board count the snapshot carries.
    expect(insert).toMatch(/bomb_pot_board_count, bomb_pot_double_board,/);
    expect(insert).toMatch(/coalesce\(v_bomb_boards, 1\), coalesce\(v_bomb_boards, 1\) >= 2,/);
  });

  it('a host can edit a table that is already running', () => {
    // Every bomb setting was write-once: TableConfigPage takes a gameType and
    // never a table id, so changing a frequency meant killing the table and
    // losing its seated players.
    expect(APP).toMatch(/path="clubs\/:clubId\/tables\/:tableId\/bomb-settings"/);
    const SETTINGS = read('src/pages/club/TableBombSettingsPage.tsx');
    expect(SETTINGS).toMatch(/fn_update_table_bomb_settings/);
    // The RPC is the authority; the page must not write the row itself.
    expect(blankNonCode(SETTINGS)).not.toMatch(/from\('tables'\)[\s\S]{0,80}\.update\(/);
    // Reachable from where a host already acts on bomb pots.
    expect(PAGE).toMatch(/bomb-settings/);
  });

  it('a club owner has a bomb-pot report, and it admits what it cannot see', () => {
    // The three v_bomb_pot_* views carry no club_id or table_id and no UI read
    // any of them — platform-operator views wearing a club-analytics label.
    expect(APP).toMatch(/path="clubs\/:clubId\/bomb-pot-report"/);
    const REPORT = read('src/pages/club/ClubBombPotReportPage.tsx');
    expect(REPORT).toMatch(/fn_club_bomb_pot_report/);
    // The three numbers the views omit entirely.
    expect(REPORT).toMatch(/Players Per Bomb/);
    expect(REPORT).toMatch(/Forced Antes Collected/);
    expect(REPORT).toMatch(/Scooped Outright/);
    // A report that quietly averages over hands it has no record of is how a
    // hole in a ledger stays invisible.
    expect(REPORT).toMatch(/totals\.unrecorded > 0/);
  });

  it('the backfill reconstructs by ARITHMETIC and refuses to guess', () => {
    const MIG = read('supabase/migrations/20260829_backfill_bomb_award_units_by_arithmetic.sql');
    // Single-winner hands only: with one winner there is nothing to infer.
    expect(MIG).toMatch(/jsonb_array_length\(COALESCE\(h\.winners, '\[\]'::jsonb\)\) = 1/);
    // Never evaluates a card — every input is a stored column.
    expect(blankNonCode(MIG)).not.toMatch(/hole_cards/);
    // Dry run is the DEFAULT, so a careless call writes nothing.
    expect(MIG).toMatch(/p_dry_run boolean DEFAULT true/);
    // Idempotent on the ledger's own key.
    expect(MIG).toMatch(
      /ON CONFLICT \(hand_history_id, pot_index, board, side, user_id\) DO NOTHING/
    );
  });

  it('the outcomes view has a horizon and stays closed', () => {
    const MIG = read(
      'supabase/migrations/20260829_bomb_columns_that_lie_and_a_view_that_never_stops.sql'
    );
    expect(MIG).toMatch(/WHERE created_at > now\(\) - interval '90 days'/);
    // CREATE OR REPLACE VIEW resurrects Supabase's default grants; the revoke
    // has to follow every redefinition or the view re-opens to anon.
    expect(MIG).toMatch(
      /REVOKE ALL ON public\.v_bomb_pot_outcomes FROM PUBLIC, anon, authenticated;/
    );
    expect(MIG).toMatch(/security_invoker = true/);
  });

  it('the ante control cannot offer half blinds an integer column will not hold', () => {
    // tables.bomb_pot_ante_multiplier is an INTEGER column (live schema).
    // Both forms offered `step 0.5`, so a host dragging to 2.5 had 3 stored
    // and every player at the table was charged the larger ante with nothing
    // said. Found by probing the edit RPC's happy path inside a rolled-back
    // transaction: it answered ok:true and echoed 3.
    //
    // The fractional case is not lost - bomb_pot_ante_fixed is `numeric` and
    // prices the ante in chips, which is the honest way to say "two and a half
    // big blinds" anyway.
    // 2026-09-04 (Operation Table Stakes, Slice 1): the cash form is
    // CashGameCreateFlow, whose "Bomb Ante" slider steps by whole big blinds.
    const FLOW = read('src/components/cash/CashGameCreateFlow.tsx');
    const anteSlider = sliceEnclosingBlock(FLOW, 'label="Bomb Ante"');
    expect(anteSlider).toMatch(/step=\{1\}/);
    expect(blankNonCode(anteSlider)).not.toMatch(/step=\{0\.5\}/);

    const SETTINGS = read('src/pages/club/TableBombSettingsPage.tsx');
    // The editor rounds on the way in rather than letting Postgres do it.
    expect(SETTINGS).toMatch(/set\('anteBB', Math\.max\(0, Math\.round\(/);
    // And the RPC says when it rounded, so the host is told rather than
    // discovering it from the felt after everyone has been charged.
    expect(SETTINGS).toMatch(/ante_multiplier_rounded/);
  });

  it('the BOMB POT! title stands above the board, measured, never at a viewport percent on the cards', () => {
    /* Dan 2026-09-04: "THE 'BOMB POT' THAT EXPLODES AND APPEARS ON THE TABLE
       NEEDS TO BE HIGHER, IT COVERS THE BOARD WHILE DISPLAYING." The title
       block was `top: 42%` of the viewport; the board is at 42.5% of the felt
       and the bomb's flop deals in the moment the title arrives. The overlay
       now measures the felt when the title phase begins and stands the block
       just above the pot/board, scaling down rather than climbing onto the
       top seats when the band is short. */
    const CSS_OVERLAY = read('src/components/table/BombPotOverlay.css');
    const OVERLAY = read('src/components/table/BombPotOverlay.tsx');
    // The geometry lives in its own module (react-refresh: a component file
    // exports only the component); the component imports and applies it.
    const ANCHOR = read('src/lib/bombPotTitleAnchor.ts');
    const block = CSS_OVERLAY.slice(
      CSS_OVERLAY.indexOf('.bpo-title-block {'),
      CSS_OVERLAY.indexOf('}', CSS_OVERLAY.indexOf('.bpo-title-block {'))
    );
    expect(block).not.toMatch(/top:\s*4\d%/);
    expect(block).toMatch(/transform-origin:\s*50% 100%/);
    // The component measures and anchors by the felt: pot/board ceiling,
    // top-seat floor, and a scale for short bands.
    expect(ANCHOR).toMatch(/export function measureTitleAnchor\(/);
    expect(OVERLAY).toMatch(/from '\.\.\/\.\.\/lib\/bombPotTitleAnchor'/);
    expect(OVERLAY).toMatch(/measureTitleAnchor\(scope, blockH\)/);
    expect(ANCHOR).toMatch(
      /rectOf\('\.pot-display'\),\s*\n?\s*rectOf\('\.pot-display__pile--pot'\),\s*\n?\s*rectOf\('\.community-area'\)/
    );
    expect(ANCHOR).toMatch(/scope\.querySelectorAll\('\.seat-wrapper'\)/);
    expect(OVERLAY).toMatch(/bottom: `\$\{titleAnchor\.bottomPx\}px`/);
    expect(OVERLAY).toMatch(/scale\(\$\{titleAnchor\.scale\}\)/);
    // Scoped to this overlay's own table, so a hidden multi-table sibling
    // (zero-size rects) can never be the anchor; measured before paint.
    expect(OVERLAY).toMatch(/containerRef\.current\?\.closest\('\.table-page'\)/);
    expect(OVERLAY).toMatch(/useLayoutEffect\(\(\) => \{\s*\n\s*if \(phase !== 'title'\)/);
    // And the fallback, for a table that has not painted, is ABOVE the board.
    expect(ANCHOR).toMatch(/export const TITLE_FALLBACK_TOP = '2\d%'/);
    // and the block's height is measured transform-independently, or a
    // resize re-reads its own scaled box and climbs back onto the seats
    expect(OVERLAY).toMatch(/titleBlockRef\.current\?\.offsetHeight/);
    expect(OVERLAY).not.toMatch(/titleBlockRef\.current\?\.getBoundingClientRect/);
  });

  it('a regular ante is seen leaving the player: the engine announces it and the felt flies it (Dan 2026-09-04)', () => {
    /* "IF THERE IS AN ANTE, THAT NEEDS TO BE 'TAKEN FROM THE PLAYER AND ADDED
       TO THE POT PRE FLOP'." The pot already counted it (postBlinds adds a
       regular ante straight to state.pot); nothing showed it moving. */
    const EVENTS = read('server/src/engine/ServerTableEngineHandEvents.ts');
    const PAGE = read('src/pages/TablePage.tsx');
    expect(EVENTS).toMatch(/type: 'antes_posted'/);
    expect(EVENTS).toMatch(/\.filter\(\(p\) => p && p\.kind === 'ante' && p\.amount > 0\)/);
    expect(PAGE).toMatch(/case 'ANTES_POSTED': \{/);
    const at = PAGE.indexOf("case 'ANTES_POSTED': {");
    const handler = PAGE.slice(at, PAGE.indexOf("case 'TURN_CHANGE': {", at));
    expect(handler).toMatch(/createChipToPotEvent\(seatPos, potPos, post\.amount\)/);
    expect(handler).toMatch(/setChipAnimations\(\(prev\) => \[\.\.\.prev, \.\.\.events\]\)/);
  });

  it('editing a table clears the bomb LIVE state', () => {
    const MIG = read('supabase/migrations/20260829_a_host_can_change_a_running_table.sql');
    // A host moving from every-10-hands to timed is starting a new schedule,
    // not resuming one — and a token from the old schedule must not detonate
    // under the new rules. Same rule fn_clone_table_row enforces for a clone.
    expect(MIG).toMatch(/bomb_pot_sched_state\s+= NULL/);
    expect(MIG).toMatch(/bomb_pot_next_due_at\s+= NULL/);
    expect(MIG).toMatch(/bomb_pot_manual_pending\s+= false/);
    // Role-gated server-side, and the audit trail is definer-only.
    expect(MIG).toMatch(/v_role IN \('owner', 'co_owner', 'admin'\)/);
    expect(MIG).toMatch(
      /REVOKE ALL ON public\.table_settings_changes FROM PUBLIC, anon, authenticated;/
    );
  });
});
