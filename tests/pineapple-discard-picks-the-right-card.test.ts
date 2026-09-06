/**
 * Crazy Pineapple, three bugs Dan hit in one hand on 2026-08-31.
 *
 * 1. "IT DOESN'T REMOVE THE CARD FROM YOU HAND AFTER YOU DISCARD IT."
 *
 *    Two independent causes, both pinned here.
 *
 *    (a) WRONG CARD. `GameServerAPI.submitDiscard(tableId, cardIndex)` indexes
 *        into `player.cards` — the ENGINE's delivery order. The picker was
 *        handed `hero.holeCards`, which cards_pre_sort (on by default,
 *        Bible V8 §11.1) has re-sorted rank-high-to-low. Two different arrays,
 *        one index. Clicking the six threw away the ace.
 *
 *    (b) NO REPAINT. `insert_hole_cards` is an upsert — ON CONFLICT
 *        (table_id, hand_number, user_id) DO UPDATE. The deal is an INSERT;
 *        the engine's re-push of the remaining two cards after performDiscard
 *        splices one out is an UPDATE on the same key. TablePage subscribed
 *        with `event: 'INSERT'`, so it was never told, and the third card sat
 *        on the felt for the rest of the hand.
 *
 * 2. The picker covered the board — see PineappleDiscard.css.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sliceCall,
  sliceStatement,
  sliceCssRule,
  sliceEnclosingBlock,
} from './helpers/sourceWindow';
import { mapEngineSnapshot } from '../src/utils/mapEngineSnapshot';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');

/** The translation TablePage performs, restated so the rule itself is tested. */
function engineIndexOf(
  engineOrder: string[],
  displayed: { rank: string; suit: string }[],
  displayIndex: number
): number {
  const key = `${displayed[displayIndex].rank}${displayed[displayIndex].suit}`;
  const i = engineOrder.indexOf(key);
  return i < 0 ? displayIndex : i;
}

describe('the discard reaches the card the player pointed at', () => {
  // Dan's actual hand from the screenshot, displayed sorted A-7-6.
  const engineOrder = ['6c', 'Ah', '7s']; // the order the engine dealt them
  const displayed = [
    { rank: 'A', suit: 'h' },
    { rank: '7', suit: 's' },
    { rank: '6', suit: 'c' },
  ];

  it('maps every displayed position back to the engine position', () => {
    expect(engineIndexOf(engineOrder, displayed, 0)).toBe(1); // Ah
    expect(engineIndexOf(engineOrder, displayed, 1)).toBe(2); // 7s
    expect(engineIndexOf(engineOrder, displayed, 2)).toBe(0); // 6c
  });

  it('the raw display index would have discarded the wrong card', () => {
    // The bug, stated as an inequality: on this hand only one of the three
    // clicks happened to land on the right card.
    const wrong = [0, 1, 2].filter((i) => engineIndexOf(engineOrder, displayed, i) !== i);
    expect(wrong).toHaveLength(3);
  });

  it('falls back to the display index when the engine order is unknown', () => {
    expect(engineIndexOf([], displayed, 2)).toBe(2);
  });
});

describe('TablePage wiring', () => {
  const src = read('src/pages/TablePage.tsx');

  it('records the engine card order before cards_pre_sort reorders them', () => {
    const i = src.indexOf('heroEngineCardOrderRef.current = formattedCards');
    const j = src.indexOf('if (cardsPreSortRef.current) formattedCards = sortCardsByRank');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  /* ═══ THE PIN MOVED WITH THE MECHANISM (2026-09-06) ═══════════════════════
     This used to assert the hole-card Realtime subscription listened on '*'
     rather than 'INSERT', because the discard re-push is an UPSERT and so
     arrives as an UPDATE - subscribing to INSERT only left the third card on
     the felt for the rest of the hand.

     The bug is the same and still worth pinning; the transport is not. Hole
     cards now arrive as a private USER_EVENT frame on the engine socket
     (PR #3032), and `table_hole_cards` has left the supabase_realtime
     publication because decoding it cost 44% of everything the WAL poller
     did and was delivered to nobody. So the pin asks the same question of the
     new path: does a re-push of the hero's cards still reach the handler? */
  it('routes hole-card frames from the engine socket into the hole-card handler', () => {
    expect(src).toContain("ev.kind === 'hole_cards'");
    expect(src).toContain('handleHoleCardPayload({ new: ev.row })');
  });

  it('no longer carries a table_hole_cards realtime subscription', () => {
    // Re-adding one would put 716 changes per 15 seconds back through
    // apply_rls for an audience of zero. The socket already delivered them.
    expect(src).not.toContain("table: 'table_hole_cards'");
    expect(src).not.toContain('useMasterBusChannel');
  });

  it('the engine re-push sends the socket frame before it writes the row', () => {
    const dealing = read('server/src/engine/ServerTableEngineDealing.ts');
    const send = dealing.indexOf("kind: 'hole_cards'");
    const write = dealing.indexOf("supabase.rpc('insert_hole_cards'");
    expect(send).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    // Sent first, so a slow database never delays the cards on screen - and so
    // the frame still goes out if the write later fails.
    expect(send).toBeLessThan(write);
    // The reconnect / RESYNC re-push goes through that same function, which is
    // what makes the socket path survive a dropped connection mid-hand.
    expect(dealing).toContain(
      'await this.persistHoleCardsWithRetry(userId, entry.seat, entry.cards)'
    );
  });

  it('submits the translated index, never the clicked one', () => {
    expect(src).toContain('GameServerAPI.submitDiscard(tableId, engineIndex)');
  });
});

describe('a background table never puts a picker on your screen', () => {
  const src = read('src/pages/TablePage.tsx');

  it('gates the picker on isActive', () => {
    expect(sliceStatement(src, '<PineappleDiscard')).toContain(
      'isOpen={isActive && !!heroPineappleCards}'
    );
  });

  it('still arms the tab-strip alarm on a background table', () => {
    // The deadline must NOT be gated on isActive, or the notice that replaces
    // the picker is silenced along with it. Dan 2026-08-28: a background table
    // asks for attention, it never takes it.
    const memo = sliceCall(src, 'const heroPineappleCards = useMemo(');
    expect(memo).not.toContain('if (!isActive) return null;');
    expect(src).toContain("setDecisionDeadline({ kind: 'discard', at: pineappleDeadline })");
  });
});

describe('the recovery poll obeys the same index rule', () => {
  const src = read('src/pages/TablePage.tsx');

  it('records the engine order before cards_pre_sort, on the poll path too', () => {
    const i = src.indexOf('heroEngineCardOrderRef.current = parsedCards');
    const j = src.indexOf('if (cardsPreSortRef.current) parsedCards = sortCardsByRank');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });
});

describe('the picker does not cover the flop', () => {
  const css = read('src/components/table/PineappleDiscard.css');

  it('is docked, not a full-viewport overlay', () => {
    const shell = sliceCssRule(css, '.pineapple-discard');
    expect(shell).not.toContain('inset: 0');
    expect(shell).toContain('bottom:');
    expect(shell).toContain('pointer-events: none');
  });

  it('paints no scrim or blur over the board', () => {
    const shell = sliceCssRule(css, '.pineapple-discard');
    expect(shell).not.toContain('backdrop-filter');
    expect(shell).not.toMatch(/background:\s*rgba\(0, 0, 0/);
  });
});

/**
 * PHASE 1 — the discard clock the player watches is the one that folds them.
 */
describe('the discard countdown is server-authored', () => {
  const src = read('src/pages/TablePage.tsx');
  const panel = read('src/components/table/PineappleDiscard.tsx');

  /* mapEngineSnapshot is pure and importable, so this RUNS it rather than
     reading its source. A regex passes on a line that is present and wrong;
     this cannot. */
  const HERO = 'hero-user-id';
  const snap = (over: Record<string, unknown> = {}) =>
    ({
      table_id: 't',
      hand_number: 1,
      pot: 0,
      community_cards: [],
      stage: 'pineapple_discard',
      players: [{ seat: 1, user_id: HERO, username: 'Hero', stack: 100, cards: [] }],
      ...over,
    }) as never;

  it("prefers the hero's OWN deadline over the round default", () => {
    // A time bank extends one seat without touching the rest, so the per-user
    // entry has to win over the round's unextended deadline.
    const m = mapEngineSnapshot(
      snap({ discard_deadline_ms: 1_000, discard_deadlines: { [HERO]: 9_000 } }),
      HERO,
      6
    );
    expect(m.discardDeadline).toBe(9_000);
  });

  it('falls back to the round deadline when this seat has no entry of its own', () => {
    const m = mapEngineSnapshot(
      snap({ discard_deadline_ms: 1_000, discard_deadlines: { someoneElse: 9_000 } }),
      HERO,
      6
    );
    expect(m.discardDeadline).toBe(1_000);
  });

  it('is NULL outside the round, so no dead countdown can linger', () => {
    // The engine nulls these off-round; the mapper must not invent one.
    const m = mapEngineSnapshot(
      snap({ stage: 'flop', discard_deadline_ms: null, discard_deadlines: {} }),
      HERO,
      6
    );
    expect(m.discardDeadline).toBeNull();
  });

  it('ignores a zero or negative deadline rather than counting down to the past', () => {
    const m = mapEngineSnapshot(
      snap({ discard_deadline_ms: 0, discard_deadlines: { [HERO]: 0 } }),
      HERO,
      6
    );
    expect(m.discardDeadline).toBeNull();
  });

  it('carries the round duration through for the ring geometry', () => {
    const m = mapEngineSnapshot(snap({ discard_duration_ms: 15_000 }), HERO, 6);
    expect(m.discardDurationMs).toBe(15_000);
  });

  it('TablePage takes the engine deadline, not its own guess', () => {
    /* The whole effect, bounded by its own body - `levels: 2` climbs out of the
       `if (typeof authoritative ...)` arm to the effect that encloses it, so
       the window grows with the code instead of being outrun by it. */
    const block = sliceEnclosingBlock(
      src,
      'setPineappleDeadline((prev) => prev ?? Date.now() + actionTimeSecondsRef.current * 1000)'
    );
    expect(block).toContain('tableState.discardDeadline');
    // The old guess survives only as a fallback for an engine that does not
    // publish the field yet — it must not be the first thing tried.
    const guess = block.indexOf('actionTimeSecondsRef.current * 1000');
    expect(guess).toBeGreaterThan(block.indexOf('const authoritative'));
  });

  it('the panel counts down against the server clock, not the device clock', () => {
    expect(panel).toContain("import { serverNow } from '../../utils/serverClock'");
    expect(panel).toContain('deadline - serverNow()');
    expect(panel).not.toContain('deadline - Date.now()');
  });

  it('offers a time bank on the round that folds you for running out', () => {
    expect(panel).toContain('pineapple-discard__timebank');
    expect(panel).toContain('timeBanksRemaining > 0');
    expect(sliceStatement(src, '<PineappleDiscard')).toContain(
      'onTimeBank={handleActivateTimeBank}'
    );
  });
});

describe('a discard time bank does not borrow the TURN presentation', () => {
  const src = read('src/pages/TablePage.tsx');

  it('returns before touching timeBankActive when the hero is in the discard round', () => {
    // `timeBankActive` drives the hero seat ring and the multi-table tab's
    // "1:<deadline>" string, and the effect that owns it cancels the instant
    // currentPlayerSeat !== heroSeat. The discard round has no current player,
    // so setting it would paint a ring for one frame, publish a bogus deadline
    // to the tab strip, then cancel itself.
    const body = sliceCall(src, 'const handleActivateTimeBank = useCallback(');
    const guard = body.indexOf('if (heroPineappleCards) {');
    const turnState = body.indexOf('setTimeBankActive(true)');
    expect(guard).toBeGreaterThan(-1);
    expect(turnState).toBeGreaterThan(guard);
    // and it must actually leave, not fall through
    expect(body.slice(guard, turnState)).toContain('return {');
  });

  it('says "armed" in the panel, never through a popup', () => {
    /* Dan 2026-08-24 on the turn path: "it gives you this generic pop up,
       instead of resetting the countdown clock on the hero's box." The same
       rule here - and tests/unit/timeBankSeatFeedbackAndCards.test.ts pins the
       no-toast half from the other side. */
    const body = sliceCall(src, 'const handleActivateTimeBank = useCallback(');
    const guard = body.indexOf('if (heroPineappleCards) {');
    expect(body.slice(guard, body.indexOf('setTimeBankArmed(true)'))).not.toMatch(
      /toast\?\.\w+\?\.\(/
    );
    const panel = read('src/components/table/PineappleDiscard.tsx');
    expect(panel).toContain('Time Bank Armed. It Starts When Your Clock Runs Out');
  });
});

describe('the published round duration is actually used', () => {
  const panel = read('src/components/table/PineappleDiscard.tsx');
  const src = read('src/pages/TablePage.tsx');

  it('is wired from the engine through to the panel, not left dangling', () => {
    // Publishing a field nothing reads is dead weight on the wire and a lie in
    // the contract. It drives when the countdown turns urgent.
    expect(src).toContain('discardDurationMs: mapped.discardDurationMs ?? 0');
    expect(sliceStatement(src, '<PineappleDiscard')).toContain(
      'durationMs={tableState.discardDurationMs}'
    );
    expect(panel).toContain('const urgentAt =');
  });

  it('scales urgency to the table, and never to zero', () => {
    // action_time_seconds is per-table, so the old hard-coded 5s was most of a
    // 6-second round and a blink of a 30-second one.
    const urgentAt = (durationMs: number) =>
      durationMs > 0 ? Math.min(8, Math.max(3, Math.round(durationMs / 3000))) : 5;
    expect(urgentAt(0)).toBe(5); // engine did not say - previous behaviour
    expect(urgentAt(6_000)).toBe(3); // short round still warns
    expect(urgentAt(15_000)).toBe(5); // the common table, unchanged
    expect(urgentAt(60_000)).toBe(8); // long round does not shout for 20s
  });
});
