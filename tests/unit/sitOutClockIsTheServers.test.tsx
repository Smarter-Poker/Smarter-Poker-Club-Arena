/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE COUNTDOWN A PLAYER SEES IS THE ENGINE'S CLOCK, NOT THIS TAB'S
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The sit-out countdown shipped on 2026-08-29 stamped `sitOutSince` from the
 * CLIENT's `Date.now()`, at the moment this tab first noticed the sit-out. So a
 * cash player who sat out and then reloaded, reconnected, or opened the table in
 * a second tab at 4:30 elapsed was shown a fresh:
 *
 *     "Your Seat Is Held For Up To 5:00"
 *
 * and evicted thirty seconds later.
 *
 * That is the same defect as the hardcoded `300` deleted on 2026-08-16, with
 * the sign reversed — it UNDER-warns instead of over-warning, on the one screen
 * that exists to tell a player their stack is about to be cashed out.
 * `table_seats.sit_out_at` is stamped by a database trigger and was built
 * precisely so the clock survives a restart; the poll that paints the badge was
 * already one column away from it.
 *
 * These pin the properties that make the readout trustworthy, at the source,
 * because the failure is a question of WHICH VALUE is read rather than of how
 * one render came out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';
import { isSitOutUrgent } from '../../src/lib/sitOutDeadline';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TABLE_PAGE = strip(readRaw('src/pages/TablePage.tsx'));
const SEAT_SLOT = strip(readRaw('src/components/table/SeatSlot.tsx'));
const BADGE = strip(readRaw('src/components/table/SitOutBadge.tsx'));
const MODAL_CSS = readRaw('src/components/table/SitOutModal.css');
const SEAT_CSS = readRaw('src/components/table/SeatSlot.css');

describe('the clock comes from the row, not from this browser', () => {
  it('the seat poll reads sit_out_at', () => {
    /* One column on a query that already runs every ten seconds and on every
       realtime change. Without it there is no authoritative clock anywhere on
       the client. */
    expect(TABLE_PAGE).toMatch(/select\('user_id, is_sitting_out, sit_out_at'\)/);
  });

  it('parses it into a per-user map the surfaces can read', () => {
    expect(TABLE_PAGE).toMatch(/setSitOutStamps\(/);
    expect(TABLE_PAGE).toMatch(/Date\.parse\(row\.sit_out_at\)/);
  });

  it('the hero adopts the server stamp when the row provides one', () => {
    expect(TABLE_PAGE).toMatch(/const serverStamp = stamps\.get\(heroId\)/);
    expect(TABLE_PAGE).toMatch(
      /setSitOutSince\(\(prev\) => \(prev === serverStamp \? prev : serverStamp\)\)/
    );
  });

  it('the local Date.now() survives only as a provisional value', () => {
    /* A sit-out deferred to the end of the current hand is not stamped until
       settlement drains it, so the countdown would otherwise be blank for a few
       seconds. The provisional value is REPLACED by the row, and can only ever
       move the deadline earlier — the safe direction on a seat about to be
       reclaimed. */
    const effect = sliceEnclosingBlock(TABLE_PAGE, 'if (!heroIsSittingOut) return null;');
    expect(effect).toMatch(/sitOutStamps\.get\(String\(userId \?\? ''\)\) \?\? Date\.now\(\)/);
  });
});

describe('the deadline is visible where the player is looking', () => {
  it('the seat badge is a component that can count, not a hardcoded string', () => {
    /* A SEPARATE PROP, not a field on `player`. It was a field first, and that
       could not work: `mapEngineSnapshot` builds a brand new player object from
       a fixed list of nine fields on every engine broadcast, so the stamp was
       erased at the next frame. */
    expect(SEAT_SLOT).toMatch(/<SitOutBadge sitOutAt=\{sitOutAt\} \/>/);
    expect(SEAT_SLOT, 'the stamp is back on the player object').not.toMatch(/player\.sitOutAt/);
    expect(SEAT_SLOT, 'the old hardcoded label is back').not.toMatch(/>\s*SITTING OUT\s*</);
  });

  it('the badge owns its own interval so it cannot defeat SeatSlot memoisation', () => {
    /* SeatSlot is memoised behind a hand-written comparator because it renders
       up to ten times per table and up to six tables at once. A per-second
       NUMBER passed through it would break that comparator sixty times a minute
       per sat-out seat; a stable STAMP does not. */
    expect(BADGE).toMatch(/memo\(SitOutBadgeInner\)/);
    expect(BADGE).toMatch(/setInterval/);
    expect(SEAT_SLOT).not.toMatch(/setInterval[\s\S]{0,200}sitOut/i);
  });

  it('the badge takes no isTournament prop, so SeatSlot keeps its rule', () => {
    /* SeatSlot carries a standing rule that nothing inside it may branch a
       VISUAL on tournament-ness — the incident behind it gave a Spin an inert
       empty seat and a stack that would not warn at 8bb. The parent withholds
       the stamp instead. */
    /* The PROPS INTERFACE, not the file: the component still passes
       `isTournament: false` into `sitOutMsRemaining`, which is the whole point
       — it has decided there is no tournament question to ask. */
    const props = BADGE.slice(
      BADGE.indexOf('export interface SitOutBadgeProps'),
      BADGE.indexOf('function SitOutBadgeInner')
    );
    expect(props).not.toMatch(/isTournament/);
    expect(props).toMatch(/sitOutAt\?:/);
    expect(TABLE_PAGE).toMatch(/tableState\.isTournament \|\| !displayPlayer\?\.id/);
  });

  it('the memo comparator compares the stamp, or the badge never receives it', () => {
    /* `paint()` writes the stamp WITHOUT changing anything else about the seat.
       If the comparator does not look at it, every compared field matches, the
       render is skipped, and on the deferred-sit-out path — the only path where
       the stamp arrives that way — the badge shows no clock for the whole five
       minutes. */
    expect(SEAT_SLOT).toMatch(/if \(prev\.sitOutAt !== next\.sitOutAt\) return false;/);
  });

  it('the seat poll no longer rewrites every player to carry a stamp', () => {
    /* `undefined !== null` for any seat that had not been through paint() made
       it report `changed` on EVERY poll, re-rendering the whole table every ten
       seconds — on tournament tables too, where the stamp is always null. */
    const at = TABLE_PAGE.indexOf('const paint = (sittingOut: Set<string>)');
    expect(at, 'paint has moved or gone').toBeGreaterThan(-1);
    const paint = TABLE_PAGE.slice(at, TABLE_PAGE.indexOf('const reload = async', at));
    expect(paint).not.toMatch(/sitOutAt/);
  });

  it('a new stamp map is only published when something moved', () => {
    expect(TABLE_PAGE).toMatch(/sameStamps\(prev, stamps\) \? prev : stamps/);
  });

  it('every countdown stops at zero instead of re-rendering forever', () => {
    /* `sitOutMsRemaining` floors at 0 rather than returning null, so anything
       keyed on "is there a deadline" stays true after expiry. Past 0:00 the
       label cannot get more urgent and there is nothing left to tick towards —
       an interval that keeps firing is a once-a-second re-render, per sat-out
       seat, for as long as the eviction sweep takes to land. */
    expect(BADGE).toMatch(/if \(next !== null && next <= 0\) clearInterval\(id\)/);
    expect(TABLE_PAGE).toMatch(/\) === 0\s*\)\s*\{\s*clearInterval\(id\);/);
    /* The modal too. An earlier version of this case was titled "every
       countdown" and pinned only two of the three. */
    const modal = strip(readRaw('src/components/table/SitOutModal.tsx'));
    expect(modal).toMatch(/=== 0\) clearInterval\(id\)/);
  });
});

describe('the CSS exists for every class the countdown renders', () => {
  /* SHIPPED BROKEN on 2026-08-29: the deadline line went out with NO rule at
     all, so it inherited nothing and wedged itself between two buttons in a
     flex row — and `--urgent` had no rule either, which made `isSitOutUrgent`
     a computed, applied, INVISIBLE no-op. A class with no rule is the quietest
     way to ship half a feature. */
  it('the modal deadline is styled, and urgent means something', () => {
    expect(MODAL_CSS).toMatch(/\.sitout-modal__deadline\s*\{/);
    expect(MODAL_CSS).toMatch(/\.sitout-modal__deadline--urgent\s*\{/);
    // It may wrap; it may not push the buttons off a narrow phone.
    const block = MODAL_CSS.slice(MODAL_CSS.indexOf('.sitout-modal__deadline {'));
    expect(block.slice(0, block.indexOf('}'))).toMatch(/max-width/);
  });

  it('the seat badge has an urgent rule too', () => {
    expect(SEAT_CSS).toMatch(/\.seat__sitout-badge--urgent\s*\{/);
  });

  it('no gold, amber or orange in either urgent rule', () => {
    /* .agent/workflows/design-guidelines.md. Red is the sanctioned alarm.

       Tested as a PROPERTY of the colours rather than as a blocklist of hex
       prefixes. A first attempt used `/#f{1,2}[abc]/` and failed on `#ffb3ae`,
       which is a salmon — red-dominant and entirely correct here. Amber, gold
       and orange are the family where GREEN sits well above BLUE; red keeps
       green and blue close together and below it. That is the actual rule, so
       that is what this measures.

       Comments are stripped first: the first `--urgent` in each file is inside
       the note explaining why the rule exists, so slicing the raw text
       measured prose. */
    for (const css of [MODAL_CSS, SEAT_CSS]) {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const at = code.indexOf('--urgent {');
      expect(at, 'the urgent rule has moved or gone').toBeGreaterThan(-1);
      const block = code.slice(at, code.indexOf('}', at));

      expect(block).not.toMatch(/orange|amber|gold/i);

      for (const hex of block.match(/#[0-9a-f]{6}/gi) || []) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        expect(r, `${hex} is not red-dominant`).toBeGreaterThanOrEqual(g);
        // Amber/gold: green far above blue. Red/salmon: the two stay close.
        expect(g - b, `${hex} reads as amber or gold`).toBeLessThan(40);
      }
      for (const rgba of block.match(/rgba?\(([^)]+)\)/g) || []) {
        const [r, g, b] = rgba
          .replace(/rgba?\(|\)/g, '')
          .split(',')
          .map((n) => Number(n.trim()));
        expect(r, `${rgba} is not red-dominant`).toBeGreaterThanOrEqual(g);
        expect(g - b, `${rgba} reads as amber or gold`).toBeLessThan(40);
      }
    }
  });
});

describe('the footer cannot show the state without the clock', () => {
  it('heroIsSittingOut uses BOTH conditions the footer renders on', () => {
    /* The footer renders on `seat.status === 'sitting_out' ||
       sittingOutIdsRef.has(userId)`, and this used to check only the first — so
       in the window the ref exists to cover, `sitOutSince` stayed null and the
       deadline silently disappeared. The player under the clock was the one who
       could not see it. */
    const declAt = TABLE_PAGE.indexOf('const heroIsSittingOut =');
    const decl = TABLE_PAGE.slice(declAt, TABLE_PAGE.indexOf(';', declAt));
    expect(TABLE_PAGE).toMatch(/const heroIsSittingOut =[\s\S]{0,200}heroSitsOutPerRow/);
    /* From STATE, not from a ref read during render. A ref mutation schedules
       nothing, so deriving this from `sittingOutIdsRef.current` made the value
       correct only when some unrelated update happened to flush in the same
       pass — and the effect keyed on it then did not run either, which is what
       made the cleared-countdown bug permanent rather than transient. */
    expect(TABLE_PAGE).toMatch(/const \[heroSitsOutPerRow, setHeroSitsOutPerRow\] = useState/);
    expect(decl).not.toMatch(/sittingOutIdsRef/);
    expect(decl.length).toBeGreaterThan(0);
  });
});

describe('the multi-table surfaces can see the deadline too', () => {
  const MULTI = strip(readRaw('src/pages/MultiTablePage.tsx'));
  const TABBAR = strip(readRaw('src/components/table/TableTabBar.tsx'));
  const TABBAR_CSS = readRaw('src/components/table/TableTabBar.css');

  it('the owning table reports its deadline upward', () => {
    /* A tab is the ONLY thing a multi-tabling player can see of a table they
       are not looking at. One tap of Sit Out At All Tables can start six
       five-minute eviction clocks, and not one surface outside the hidden
       tables reported any of them. */
    expect(TABLE_PAGE).toMatch(/sitOutDeadlineMs: heroTabSitOutDeadlineMs/);
    expect(MULTI).toMatch(/sitOutDeadlineMs\?: number/);
  });

  it('the tab renders a countdown, precomputed like its siblings', () => {
    /* Seconds in, not a deadline: this bar has no clock of its own and should
       not grow one — `decisionSecondsLeft` and `timeBankSecondsLeft` are
       already precomputed by the parent. */
    expect(TABBAR).toMatch(/sitOutSecondsLeft\?: number/);
    expect(MULTI).toMatch(/sitOutSecondsLeft:/);
    expect(TABBAR).toMatch(/table-tab-bar__tab-name">SEAT</);
  });

  it('the tab bar clock keeps running while only a sit-out is live', () => {
    /* The 1s tick was gated on a turn, a decision or a time bank. A sat-out
       player has none of those — so the most important clock on the page was
       the one that stopped. */
    expect(MULTI).toMatch(/t\.sitOutDeadlineMs !== undefined\s*\)\s*;/);
  });

  it('the dock treats a seat about to be lost as urgent', () => {
    /* It was gated on `isMyTurn` alone: a countdown, a title flip, a favicon
       badge and a tick-tock for a TURN, and nothing for a seat. Losing a turn
       costs a hand; losing a seat cashes out a stack. */
    expect(MULTI).toMatch(/const urgentSeat = live/);
    /* The exact predicate moved into the filter body a few hours later, to add
       the `> 0` bound — see "the dock requires a LIVE clock" below. Pinned on
       the name rather than the call shape so the two cases cannot disagree. */
    expect(MULTI).toMatch(/isSitOutUrgent\(/);
  });

  it('the urgent tab style exists, and is not amber', () => {
    expect(TABBAR_CSS).toMatch(/\.table-tab-bar__tab-label--seat-urgent/);
    const code = TABBAR_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = code.indexOf('--seat-urgent');
    const block = code.slice(at, code.indexOf('}', at));
    expect(block).not.toMatch(/orange|amber|gold/i);
  });

  it('the sit-out toast says what it just started', () => {
    /* "Sitting Out" alone omits the only part with a consequence. */
    expect(MULTI).toMatch(/Your Seat Is Held For Up To 5 Minutes/);
    expect(MULTI).toMatch(/You Will Be Blinded Off/);
  });
});

describe('one request at a time, and one wording', () => {
  it('sit-out and sit-in are serialised', () => {
    /* Rapid out -> in -> out issued three independent POSTs with no ordering
       guarantee while every one updated the UI optimistically: the client could
       settle showing "sitting out" over a server that had the player in the
       game, being dealt in and blinded. */
    expect(TABLE_PAGE).toMatch(/sitOutRequestInFlightRef/);
  });

  it('the footer asks the shared function for its wording instead of editing it', () => {
    /* It used `.replace('Sitting Out', 'You Are Sitting Out')` — string surgery
       on the output of the one function that exists so two surfaces cannot word
       the same rule differently. */
    expect(TABLE_PAGE).not.toMatch(/\.replace\('Sitting Out'/);
    expect(TABLE_PAGE).toMatch(/'You Are Sitting Out'\s*\)/);
  });

  it('the read that owns the eviction clock reports its failures', () => {
    expect(TABLE_PAGE).toMatch(/TablePage\.seat_sitout_poll_failed/);
  });

  it('the hero countdown is announced to a screen reader', () => {
    /* The same file gives a bomb-pot flavour banner an aria-live and said
       nothing at all about a seat thirty seconds from being cashed out. ONE
       live region — three would read the same sentence three times a second. */
    expect(TABLE_PAGE).toMatch(/spectator-footer-bar__label"\s*\n?\s*role="status"/);
    const regions = (TABLE_PAGE.match(/seat__sitout-badge[\s\S]{0,200}aria-live/g) || []).length;
    expect(regions, 'the seat badges must NOT each be a live region').toBe(0);
  });
});

describe('one sit-back-in, and a dock that does not pin itself', () => {
  const MULTI2 = strip(readRaw('src/pages/MultiTablePage.tsx'));
  const LAYER = strip(readRaw('src/components/table/TableModalsLayer.tsx'));

  it('the modal reports intent; TablePage owns the request', () => {
    /* There were TWO implementations of "sit back in" and only one was behind
       the in-flight guard, so the out -> in -> out race was still reachable by
       alternating the MODAL's I'm Back with the table menu's Sit Out — while
       the guard's own comment claimed to cover four entry points. It also let
       the two buttons' cleanup and failure toasts drift apart, which they had. */
    expect(LAYER).not.toMatch(/setSitOut\(tableId, false\)/);
    expect(LAYER).not.toMatch(/from '\.\.\/\.\.\/services\/GameServerAPI'/);
    expect(TABLE_PAGE).toMatch(/const handleSitBackIn = useCallback/);
    const fn = sliceEnclosingBlock(TABLE_PAGE, 'const handleSitBackIn = useCallback');
    expect(fn).toMatch(/sitOutRequestInFlightRef\.current/);
    expect(fn).toMatch(/finally/);
  });

  it('the dock requires a LIVE clock, not merely an urgent one', () => {
    /* `isSitOutUrgent` is deliberately unbounded below — it is the STYLING
       predicate and a badge must stay red at 0:00, when the seat is at its most
       at-risk. The dock renders a COUNTDOWN, so an unbounded test pinned it to
       `urgent` with `0s` forever once the deadline passed, favicon badge and
       tick-tock included: exactly what its own comment claims to avoid. */
    expect(MULTI2).toMatch(/left !== null && left > 0 && isSitOutUrgent\(left\)/);
  });

  it('and the styling predicate still fires at zero', () => {
    expect(isSitOutUrgent(0)).toBe(true);
    expect(isSitOutUrgent(-5_000)).toBe(true);
    expect(isSitOutUrgent(null)).toBe(false);
  });

  it('the tab report re-fires when the deadline itself changes', () => {
    /* `heroTabSittingOut` alone covers the true/false EDGES. It does not cover
       a quiet table where the deadline arrives, or the poll corrects it, AFTER
       the flag has flipped — the multi-table countdown would never learn it. */
    /* Bounded by the array's own closing bracket, not by a byte count.
       `slice(indexOf(x), 400)` is the magic-number window
       tests/unit/noFixedSizeSourceWindows.test.ts exists to forbid — it caught
       this on the first run, which is the whole point of it. */
    const at = TABLE_PAGE.indexOf('heroTabResult,');
    expect(at, 'the report effect deps have moved').toBeGreaterThan(-1);
    const deps = TABLE_PAGE.slice(at, TABLE_PAGE.indexOf(']);', at));
    expect(deps).toMatch(/heroTabSitOutDeadlineMs/);
    expect(deps).toMatch(/tableState\.isTournament/);
  });
});
