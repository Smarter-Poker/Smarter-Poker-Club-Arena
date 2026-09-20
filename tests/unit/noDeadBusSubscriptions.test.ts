import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BUS SUBSCRIPTION NOBODY PUBLISHES IS A TRAP
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This repo keeps rediscovering the same defect. The changelog has it three
 * times in different clothes:
 *
 *   - BOMB_POT_TRIGGERED: "BombPotOverlay is mounted and has always listened
 *     for this bus event; nothing has ever emitted it."
 *   - TournamentResultCard and ClubLobby's router-state reader, both addressed
 *     to a route that never read them.
 *   - 2026-08-23: TIME_BANK_ACTIVATED arrived from the hub in snake_case while
 *     the subscriber guarded on `payload.tableId`, so every event returned on
 *     its first line and the time bank appeared not to work.
 *
 * The shape is always the same and always silent: a handler that looks wired,
 * reads correctly, and never runs. Nothing throws. Nothing logs.
 *
 * So the rule is mechanical rather than remembered. Every name this client
 * SUBSCRIBES to must be a name something in the client EMITS — including the
 * hub dispatch in TablePage, which converts engine events into bus events and
 * is itself just a pile of masterBus.emit calls.
 *
 * KNOWN_DEAD below is a debt list, not a permission slip. Every entry was
 * checked on 2026-08-23 and is REDUNDANT rather than broken - the same truth
 * reaches the client another way - which is why they are tolerated instead of
 * deleted wholesale in one risky sweep. The list may shrink. It must never
 * grow: a new name here means a feature that silently does nothing.
 */
const SRC = resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC);

function scan() {
  const subscribed = new Map<string, string>();
  const emitted = new Set<string>();

  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    const rel = file.replace(SRC + '/', '');

    for (const m of src.matchAll(/useMasterBusSubscription\(\s*'([A-Z0-9_]+)'/g)) {
      if (!subscribed.has(m[1])) subscribed.set(m[1], rel);
    }
    for (const m of src.matchAll(/useMasterBusSubscriptions\(\s*\[([^\]]*)\]/g)) {
      for (const n of m[1].matchAll(/'([A-Z0-9_]+)'/g)) {
        if (!subscribed.has(n[1])) subscribed.set(n[1], rel);
      }
    }
    // BLIND SPOT (fixed 2026-08-28): this matched only `masterBus.subscribe(`
    // and could never match `masterBus.subscribeDebounced(` — the single most
    // common direct idiom in the repo. Nine dead subscriptions hid behind
    // that one missing word while the suite stayed green, including three
    // security dashboards and the VIP points feed.
    for (const m of src.matchAll(/masterBus\.subscribe(?:Debounced)?\(\s*'([A-Z0-9_]+)'/g)) {
      if (!subscribed.has(m[1])) subscribed.set(m[1], rel);
    }
    for (const m of src.matchAll(/masterBus\.emit\(\s*'([A-Z0-9_]+)'/g)) emitted.add(m[1]);
  }

  return { subscribed, emitted };
}

/**
 * Checked 2026-08-23. Each of these is REDUNDANT, not broken:
 *
 *   TIME_BANK_EXTENDED / TIME_BANK_EXTENSION_DENIED
 *     The engine publishes time_bank_remaining and time_bank_uses_remaining on
 *     every snapshot, and handleBuyTimeBanks reports its own purchase from the
 *     RPC result. Nothing depends on these handlers running.
 *   ACTION_REJECTED / ACTION_TIMER_STARTED / ACTION_TIMER_EXPIRED /
 *   STATE_INTEGRITY_VIOLATION / WS_RECONNECTING / TRANSACTION_LOGGED
 *     Superseded by the server-authoritative snapshot during the migration.
 *
 * REVIVED 2026-08-28, and removed from this list: HAND_WON and SHOWDOWN_START.
 * Their entry above claimed the snapshot superseded them, and that was wrong
 * in a way worth recording, because this file's header calls itself "a debt
 * list, not a permission slip" and promises every entry was CHECKED. A
 * snapshot cannot produce a chat line. Those two subscribers are the only
 * code in the app that writes `type: 'DEALER'` messages — "Ari & Sam split
 * the pot - 4,200", "Showdown: Ari (Flush) vs Sam (Two Pair)" — and the only
 * other route to one, a `message_type = 'dealer'` row, is refused by the chat
 * RLS policy. So the dealer voice was not redundant, it was missing: every
 * hand ended with the chat panel silent about who won. TablePage now emits
 * HAND_WON once per hand at HAND_COMPLETE (from the merged winner mirror, so
 * side pots and hi-lo splits announce once with the true total) and
 * SHOWDOWN_START from the showdown event's revealed hands.
 *
 * REVIVED 2026-08-23, and removed from this list: BREAK_START, BREAK_END,
 * TOURNAMENT_BREAK, TOURNAMENT_BREAK_END, TABLE_BALANCE_EXECUTED and
 * RAKEBACK_DISTRIBUTED. The first four now come off the server's existing
 * `t-break-<id>` broadcast through tournamentEventBridge; the last two are
 * emitted on the hub by ServerTableEngineBase, whose callbacks used to be a
 * bare console.log. The list shrank, which is what it is for.
 *
 * REVIVED 2026-09-20, and removed from this list: TIME_BANK_STOPPED,
 * TIME_BANK_DEPLETED, TIME_BANK_EXPIRED, STRADDLE_TOGGLED and
 * PRE_ACTION_EXECUTED. All five were entered as REDUNDANT and all five
 * entries were wrong, in the same way the HAND_WON entry above was wrong:
 *
 *   The time bank three. `persistTimeBankState` is the ONLY caller of
 *   setTimeBankActive(false) in the app. TIME_BANK_ACTIVATED sets the badge
 *   to true through its own case in the dispatcher; these three are the only
 *   thing that sets it back. The snapshot mirrors the seconds and the uses,
 *   not the active flag, so "nothing depends on these handlers running" was
 *   the opposite of true: the hero's time-bank UI latched on.
 *
 *   STRADDLE_TOGGLED. The optimistic local update the entry describes is real
 *   and it is why this looked like it worked - for ONE seat. useTableChat
 *   raises a table-wide SYSTEM line from the same event, and every other seat
 *   at the table heard nothing.
 *
 *   PRE_ACTION_EXECUTED. Filed under "superseded by the snapshot", and a
 *   snapshot cannot produce a chat line - the same sentence this file already
 *   had to write for HAND_WON. "Player 1a2b auto-folded" has no other source.
 *
 * All five now have a publisher: the engine forwards them from the private
 * sub-engine callback onto the table hub (ServerTableEngineBase) and
 * TablePage's dispatcher carries them onto the bus.
 */
const KNOWN_DEAD = new Set([
  'ACTION_REJECTED',
  'ACTION_TIMER_EXPIRED',
  'ACTION_TIMER_STARTED',
  'STATE_INTEGRITY_VIOLATION',
  'TIME_BANK_EXTENDED',
  'TIME_BANK_EXTENSION_DENIED',
  'TRANSACTION_LOGGED',
  'WS_RECONNECTING',
]);

describe('every bus subscription has a publisher', () => {
  const { subscribed, emitted } = scan();

  it('finds the bus wiring at all (guards against a regex that stopped matching)', () => {
    expect(subscribed.size).toBeGreaterThan(50);
    expect(emitted.size).toBeGreaterThan(50);
    expect(emitted.has('HAND_STARTED') || emitted.has('TIME_BANK_ACTIVATED')).toBe(true);
  });

  it('adds no NEW subscription that nothing emits', () => {
    const dead = [...subscribed.keys()]
      .filter((n) => !emitted.has(n) && !KNOWN_DEAD.has(n))
      .sort()
      .map((n) => `${n}  (subscribed in ${subscribed.get(n)})`);

    expect(
      dead,
      'These are subscribed and emitted by nobody, so the handler can never run ' +
        'and the feature silently does nothing. Either emit the event, or drop ' +
        'the handler. Do not add it to KNOWN_DEAD to make this pass:\n' +
        dead.join('\n')
    ).toEqual([]);
  });

  it('keeps KNOWN_DEAD honest — an entry that came alive must leave the list', () => {
    const revived = [...KNOWN_DEAD].filter((n) => emitted.has(n)).sort();
    expect(
      revived,
      'These now HAVE a publisher, so they are no longer dead. Remove them from ' +
        'KNOWN_DEAD so the list keeps shrinking:\n' +
        revived.join('\n')
    ).toEqual([]);
  });

  it('KNOWN_DEAD contains nothing that is not actually subscribed', () => {
    const stale = [...KNOWN_DEAD].filter((n) => !subscribed.has(n)).sort();
    expect(
      stale,
      'No longer subscribed anywhere; drop from KNOWN_DEAD:\n' + stale.join('\n')
    ).toEqual([]);
  });
});
