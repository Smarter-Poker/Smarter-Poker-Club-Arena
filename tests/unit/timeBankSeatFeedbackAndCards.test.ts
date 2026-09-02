import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

/**
 * Dan 2026-08-24, two reports about one button:
 *
 *   "when you use a time bank, it gives you this generic pop up, instead of
 *    resetting the countdown clock on the hero's box"
 *
 *   "when you use a time bank, it makes your cards disappear or not appear for
 *    a couple hands!!"
 *
 * These are source-level assertions on purpose. Every defect below is a
 * WIRING fact that TypeScript cannot see and a rendering test would sail past:
 *
 *   - an empty array being truthy, so a `||` fallback can never fire;
 *   - a refusal string whose meaning is the opposite of what the branch assumed;
 *   - a `useState` written in four places and read in none;
 *   - a memo comparator that silently swallows a new prop.
 *
 * Reaching any of them behaviourally needs a live engine, a websocket sequence
 * gap and a twenty-second wait.
 *
 * ── COMMENTS ARE NOT CODE ──
 *
 * Every fix below carries a comment quoting the broken line it replaced — that
 * is house style, and it is what makes the next reader understand why the code
 * looks the way it does. But it also means a naive
 * `expect(SRC).not.toContain('sp.cards || existing?.holeCards')` matches the
 * TOMBSTONE and fails on correct code. Worse is the reverse: a positive
 * assertion can be satisfied by a comment alone, so the test would pass with
 * the implementation deleted.
 *
 * So the source is read with comments removed. The `[^:"'\`\\]` guard in front
 * of `//` keeps `https://` and friends intact.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const readCode = (p: string): string =>
  stripComments(readFileSync(resolve(__dirname, '../..', p), 'utf8'));

const TABLE_PAGE = readCode('src/pages/TablePage.tsx');
const SEAT_SLOT = readCode('src/components/table/SeatSlot.tsx');
const ENGINE = readCode('server/src/engine/ServerTableEngine.ts');
const TURNS = readCode('server/src/engine/ServerTableEngineTurns.ts');

describe("a resync must not wipe the hero's hole cards", () => {
  /* THE BUG: GAME_START is the full-state resync, dispatched by
     `requestResync()` on any websocket sequence gap. Its player merge read

         holeCards: ... ? sp.cards || existing?.holeCards || [] : []

     and the engine scrubs the hero's own cards out of every non-showdown
     snapshot on purpose, so `sp.cards` is `[]` for the whole hand. `[]` is
     TRUTHY, so `[] || existing` is `[]` — the fallback could not fire and the
     hero's hand vanished mid-hand. It did not come back either: the snapshot
     merge guard restores only from a NON-empty previous holding, and the
     bounded recovery poll re-arms at HAND_STARTED, which is why the cards
     stayed missing "for a couple hands" rather than a couple of seconds. */
  it('never falls back with `sp.cards ||`, which an empty array defeats', () => {
    expect(TABLE_PAGE).not.toContain('sp.cards || existing?.holeCards');
  });

  it('tests LENGTH before preferring the snapshot over what is already held', () => {
    // The hero branch must PRESERVE what is already held when the snapshot
    // carries nothing, because "no cards in this snapshot" means "no news".
    /* 2026-09-01: one condition was added in front of the preserve, because
       this merge runs on the sequence gap that loses HAND_STARTED and was
       therefore able to walk a dead hand across a hand boundary. The preserve
       itself is intact and still pinned here - what changed is that a holding
       the incoming board has already disproved is dropped instead of carried. */
    expect(TABLE_PAGE).toMatch(
      /holeCards:\s*sp\.user_id === userId\s*\?\s*sp\.cards\?\.length\s*\?\s*sp\.cards\s*:\s*heroHoldIsExpired\(existing\?\.holeCards\)\s*\?\s*\[\]\s*:\s*existing\?\.holeCards/
    );
  });

  it('still hides villains who folded or were never revealed', () => {
    // The hero branch is a preserve; the villain branch must stay a reveal
    // gate, or a resync would start showing folded opponents' hands.
    expect(TABLE_PAGE).toMatch(
      /:\s*sp\.cards\?\.length && !sp\.is_folded\s*\?\s*sp\.cards\s*:\s*\[\]/
    );
  });

  it('documents the engine scrub this depends on', () => {
    // If the engine ever starts sending the hero their own cards in every
    // snapshot, the preserve above becomes dead weight rather than a fix —
    // pin the assumption so that change is noticed here.
    expect(ENGINE).toMatch(/const cardsOut = showCards/);
  });
});

describe('a time bank reports on the hero seat, not through a popup', () => {
  it('does not toast on the armed branch', () => {
    const start = TABLE_PAGE.indexOf('if ((result as { armed?: boolean }).armed) {');
    expect(start).toBeGreaterThan(-1);
    const armed = TABLE_PAGE.slice(start, TABLE_PAGE.indexOf('setTimeBankActive(true);', start));
    expect(armed.length).toBeGreaterThan(0);
    expect(armed).not.toMatch(/toast\?\.\w+\?\.\(/);
    expect(armed).toContain('setTimeBankArmed(true)');
  });

  it('passes the armed state to the acting seat', () => {
    expect(TABLE_PAGE).toMatch(/timeBankArmed=\{/);
  });

  it('clears the arm when the turn moves on, so it cannot latch', () => {
    // `timeBankActive` latching across hands is on record as half of the
    // original cards-disappear report; this one is cleared explicitly.
    expect(TABLE_PAGE).toMatch(/if \(!isHeroTurnContext\) setTimeBankArmed\(false\);/);
  });

  it('clears the arm when the engine actually redeems the bank', () => {
    const redeem = TABLE_PAGE.indexOf('if (evtPlayerId === userId) {');
    expect(redeem).toBeGreaterThan(-1);
    expect(sliceBlockAfter(TABLE_PAGE, 'if (evtPlayerId === userId) {')).toContain(
      'setTimeBankArmed(false)'
    );
  });

  it('SeatSlot renders the armed state and repaints when it changes', () => {
    expect(SEAT_SLOT).toContain('timeBankArmed?: boolean;');
    expect(SEAT_SLOT).toContain('seat--tb-armed');
    // Without the comparator line the memo swallows the arm and the seat never
    // repaints — a silent regression straight back to "the toast was the only
    // feedback".
    expect(SEAT_SLOT).toMatch(/if \(prev\.timeBankArmed !== next\.timeBankArmed\) return false;/);
  });
});

describe('an already-granted bank must not be auto-folded away', () => {
  /* THE BUG: when hero ARMED a bank earlier in the turn, the engine redeems it
     the instant the primary clock expires. The client's RAF hits zero at the
     same moment and POSTs again, so the engine answers 'Your Time Bank Is
     Already Running' — a refusal meaning the OPPOSITE of what the branch
     assumed: the bank was granted and ~20 fresh seconds are on the clock.
     The client folded. Only a 6-second failsafe grace hid how often. */
  const start = TABLE_PAGE.indexOf('void GameServerAPI.activateTimeBank(tableId, userId).then');
  const onTimeout = sliceEnclosingBlock(
    TABLE_PAGE,
    'void GameServerAPI.activateTimeBank(tableId, userId).then'
  );

  it('treats "already running" as a grant rather than a refusal', () => {
    expect(start).toBeGreaterThan(-1);
    const guardIdx = onTimeout.search(/already running/i);
    const foldIdx = onTimeout.indexOf('handleTimerAutoFold()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(foldIdx).toBeGreaterThan(guardIdx); // the guard returns before the fold
  });

  it('still auto-folds on every other refusal', () => {
    expect(onTimeout).toContain('handleTimerAutoFold()');
  });

  it('pins the exact server string the guard matches', () => {
    // If the engine reworded this, the client guard above stops matching and
    // the auto-fold bug returns silently. Fail here instead.
    expect(TURNS).toContain("'Your Time Bank Is Already Running'");
  });
});

describe('the time bank counter tracks the engine instead of drifting', () => {
  /* `mapEngineSnapshot` DECLARES `time_bank_uses_remaining` on its input type
     and never maps it out, so the only writers of `timeBanksRemaining` were a
     mount-time DB read, the TIME_BANK_ACTIVATED handler and the purchase RPC —
     while the engine published the number on every snapshot. Miss one event
     and the count drifts, which matters because the press is gated on it. */
  const MAPPER = readCode('src/utils/mapEngineSnapshot.ts');

  it('reads the count straight off the snapshot', () => {
    expect(TABLE_PAGE).toMatch(/time_bank_uses_remaining/);
    /* Was `Math.max(prev, uses)`. Dan 2026-08-26: "the time bank defaults to
       4, even though I have 481." That floor was half of why — it can only
       ever RAISE the number, so:
         - the stale seed could never be corrected downward, and
         - `TimeBankEngine.getUsesRemaining` answers 0 for a player it has not
           initialised (it only initialises in the DEALING path), so a seated
           player who had not yet been dealt in reported 0 and `max(4, 0)`
           held the wrong 4 on screen;
         - a bank the player SPENDS could never be reflected either.
       The engine is authoritative about the seat, so its number is taken. */
    expect(TABLE_PAGE, 'the snapshot count must be assigned, not floored').toMatch(
      /setTimeBanksRemaining\(uses\)/
    );
    expect(TABLE_PAGE, 'the Math.max floor is back').not.toMatch(
      /setTimeBanksRemaining\(\(prev\) => Math\.max\(/
    );
  });

  it('never seeds a fabricated count, and reads the ledger that owns the real one', () => {
    /* The seed was `useState(4)` — a placeholder that looks like data. The
       true balance is account-scoped (SUM of feature_purchases.uses_remaining,
       exposed by fn_time_bank_allowance), not the seat column that also
       DEFAULTS to 4. */
    expect(TABLE_PAGE, 'the hardcoded seed is back').not.toMatch(
      /useState\(4\)[\s\S]{0,40}timeBanksRemaining|timeBanksRemaining[^\n]*useState\(4\)/
    );
    expect(TABLE_PAGE, 'null means "not loaded yet", not "you have none"').toMatch(
      /useState<number \| null>\(null\)/
    );
    expect(TABLE_PAGE, 'nothing reads the purchase ledger').toMatch(/fn_time_bank_allowance/);
  });

  it('treats a snapshot with no figure as no news, not as zero', () => {
    // Writing 0 on `undefined` would refuse a press for banks the player holds.
    expect(TABLE_PAGE).toMatch(/typeof uses === 'number' && Number\.isFinite\(uses\)/);
  });

  it('still explains why it bypasses the mapper', () => {
    // If the mapper ever starts emitting the field, this bypass becomes
    // redundant rather than wrong — but the input declaration must still exist
    // or the engine has renamed the column underneath both of them.
    expect(MAPPER).toContain('time_bank_uses_remaining');
  });
});

describe('the time bank counter is not a dead tap', () => {
  it('does not open a panel that no longer exists', () => {
    /* `showTimeBank` is written in several places and READ IN NONE — the
       floating panel it opened was deleted and the state outlived it, so a
       player WITH banks left tapped the counter and nothing happened. */
    const start = TABLE_PAGE.indexOf('<TimebankCounter');
    expect(start).toBeGreaterThan(-1);
    const counter = TABLE_PAGE.slice(start, TABLE_PAGE.indexOf('<PreviousHandCard', start));
    expect(counter.length).toBeGreaterThan(0);
    expect(counter).not.toContain('setShowTimeBank(true)');
    expect(counter).toContain('setShowTimeBankStore(true)');
  });
});
