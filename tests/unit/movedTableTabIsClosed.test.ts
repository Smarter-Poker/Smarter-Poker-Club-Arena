/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TABLE THE SERVER MOVED YOU OFF MUST NOT STAY ON SCREEN
 *  (Dan 2026-08-28, bug 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported, verbatim: "the connection failed (or maybe the server restarted).
 * when it reconnected, it created 2 tables, and was displaying future hands on
 * the table on the left that havent yet been dealt to the table on the right."
 *
 * Reproduced from production rather than guessed at. In `Union PKO Afternoon
 * (PLO4)` 4f42d847 the balancer moved the hero from Table 1 seat 5 to Table 2
 * seat 2 at 17:30:21 — the source seat's `left_at` (17:30:21.507) and the
 * destination's `joined_at` (17:30:21.777) are 270ms apart and correctly
 * ordered, so the SERVER did this right. The client did not follow:
 *
 *   - TABLE_SEATED fired for Table 2, so a second tab appeared;
 *   - nothing fires for the table you were moved OFF — TABLE_LEFT is for a
 *     leave the player initiated — so Table 1's tab stayed;
 *   - its TablePage stayed mounted, frozen on hand #3299868, which has NO
 *     `hand_history` row at all because it never completed for him.
 *
 * That is the entire report: two tabs, both drawing the hero's last-delivered
 * hole cards (SeatSlot keeps those alive deliberately), one of them stopped on
 * a hand that was never finished anywhere. Which one looks "ahead" depends
 * only on which you are looking at.
 *
 * Both halves are pinned here, because it takes both to produce the bug.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SRC = read('src/pages/MultiTablePage.tsx');
/** Strip comments so a guard cannot pass on prose that merely mentions a name. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = code(SRC);

describe('the seat rebuild prunes, not just adds', () => {
  /**
   * PIN MOVED 2026-08-30, and the move is the point.
   *
   * These two used to assert the TEXT of an inline `prev.filter(...)`. They
   * passed while the prune did nothing, because the predicate they matched
   * asked for a `kind` field that the rebuild's OWN tabs were built without —
   * and after a reload those are the only tabs there are. A regex over source
   * cannot see that; it only sees that the line exists.
   *
   * The predicate now lives in src/utils/tabSlots.ts and is pinned BY
   * BEHAVIOUR in tests/unit/tabSlots.test.ts, which runs it against every tab
   * shape this file constructs. What is left here is the wiring: that the
   * rebuild still calls it, and still calls it with the live seat set.
   */
  it('closes a seated tab whose seat the server has closed', () => {
    // The merge used to be purely additive: `[...prev, ...additions]`. Right
    // for an observer tab, wrong for one asserting `seated: true` about a seat
    // that no longer exists.
    expect(CODE).toMatch(/const liveSeatIds = new Set\(ids\)/);
    expect(CODE).toMatch(/survivors\s*=\s*pruneStaleSeatedTabs\(prev, liveSeatIds\)/);
  });

  it('never prunes an observer tab or a lobby tab', () => {
    // An observer holds no seat by definition and a lobby tab is not a table;
    // pruning either would delete something the player deliberately opened.
    // The rule itself is asserted behaviourally in tabSlots.test.ts; this pins
    // that the container has not gone back to rolling its own predicate.
    expect(CODE).toMatch(
      /import \{[\s\S]*?pruneStaleSeatedTabs[\s\S]*?\} from '\.\.\/utils\/tabSlots'/
    );
    expect(CODE).not.toMatch(/prev\.filter\(\s*\(t\) =>\s*!\(t\.kind === 'table'/);
  });

  it('gives its own rebuilt tabs the kind field every other factory sets', () => {
    // The root cause of the hole above: `additions` omitted `kind`, so a tab
    // restored by a reload did not answer to `kind === 'table'`.
    expect(CODE).toMatch(/kind: 'table' as const,\s*\n\s*seated: true,/);
  });

  it('and carries isTournament, which four readers treat as cash when absent', () => {
    /* Same defect class, found in the same factory on the follow-up audit: the
       flag was derived for `gameCode(...)` and then dropped. Absent, it reads
       as "cash" at the sit-out toast, the Sit Out All cash count, the profit
       chip (a cash-only feature by Dan's rule) and the tile raise slider.
       `isTournamentRow` itself is pinned behaviourally in tabSlots.test.ts. */
    expect(CODE).toMatch(/const rowIsTournament = isTournamentRow\(row\)/);
    expect(CODE).toMatch(/isTournament: rowIsTournament,/);
    // The balancer-move branch is tournament-only by construction.
    expect(CODE).toMatch(/isTournament: true,\s*\n\s*isMyTurn: false,/);
  });

  it('cannot omit kind again: the compiler is the guard now', () => {
    /* Dan 2026-08-31. Two rounds of fixing individual factories only moved the
       hole — a THIRD site (the initial state built from the URL) was still
       omitting `kind`, and tsc named it the moment the field became required.
       A required field is the one guard that cannot rot: it is checked on
       every build rather than by a regex somebody has to keep accurate. This
       assertion is deliberately about the TYPE, which is the whole mechanism. */
    /* 2026-09-04: a third kind, 'hub' (a World Hub page in a slot). Still
       required - that is the mechanism this pin exists for. */
    expect(CODE).toMatch(/\n\s*kind: 'table' \| 'lobby' \| 'hub';/);
    expect(CODE).not.toMatch(/kind\?: 'table' \| 'lobby'/);
  });

  it('builds the URL tab with the same fields as the route effect', () => {
    /* The initial state and the route effect construct the SAME tab from the
       same URL, and had drifted: the initial one carried neither `kind` nor
       `gameCode`, so a deep link or a refresh at the table produced a tab the
       prune could not see and a blank chip in the strip. */
    expect(CODE).toMatch(/const nameFromUrl = formatGameTitle\(searchParams\.get\('name'\)\)/);
    expect(CODE).toMatch(
      /gameCode: searchParams\.get\('code'\) \|\| gameCodeFromName\(nameFromUrl\)/
    );
  });

  it('still returns the same array reference when nothing changed', () => {
    // The P1-2 render-loop fix depends on this identity bail-out.
    expect(CODE).toMatch(/if \(prunedRef\.current === 0 && additions\.length === 0\) return prev;/);
  });

  it('tells the player instead of closing a table silently', () => {
    expect(SRC).toMatch(/You were moved to a new table/);
    // House popup rule: no em dashes in popup text.
    const toastArgs = SRC.match(/'You were moved[^']*'/g) ?? [];
    expect(toastArgs.length).toBeGreaterThan(0);
    for (const t of toastArgs) expect(t).not.toMatch(/—/);
  });
});

describe('the rebuild runs again on reconnect', () => {
  it('WS_CONNECTED bumps the resync token', () => {
    // The one moment this client's picture of "which tables am I at" is most
    // likely to be stale was the one moment it never re-read server truth.
    expect(CODE).toMatch(
      /useMasterBusSubscription\('WS_CONNECTED',[\s\S]{0,300}?setSeatResyncToken\(\(n\) => n \+ 1\)/
    );
  });

  it('and the effect actually depends on that token', () => {
    expect(CODE).toMatch(/\[user\?\.id, seatResyncToken\]/);
  });

  it('an unreadable seat list prunes nothing', () => {
    // UNKNOWN is not "you hold no seats". Without this the first failed read
    // would close every table the player is sitting at.
    expect(CODE).toMatch(
      /if \(cancelled \|\| seatErr \|\| !seatRows \|\| seatRows\.length === 0\) return;/
    );
  });
});

describe('pruning does not move the player to another table', () => {
  it('follows the watched table by identity, not by index', () => {
    // Section 10.6: "YOU CAN NEVER EVER AUTO CHANGE TABLES FOR A USER". A
    // prune ABOVE activeIndex shifts every later position down one, so leaving
    // the number alone lands the player on a different table without them
    // touching anything — the forbidden auto-switch, arriving by accident.
    expect(CODE).toMatch(/const watchedId = tablesRef\.current\[activeIndexRef\.current\]\?\.id/);
    expect(CODE).toMatch(
      /const idx = tablesRef\.current\.findIndex\(\(t\) => t\.id === watchedId\)/
    );
    expect(CODE).toMatch(
      /if \(idx !== -1 && idx !== activeIndexRef\.current\) setActiveIndex\(idx\)/
    );
  });
});
