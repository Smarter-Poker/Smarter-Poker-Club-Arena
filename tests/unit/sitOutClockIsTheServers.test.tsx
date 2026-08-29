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
    expect(TABLE_PAGE).toMatch(/sitOutAtRef\.current = stamps/);
    expect(TABLE_PAGE).toMatch(/Date\.parse\(row\.sit_out_at\)/);
  });

  it('the hero adopts the server stamp when the row provides one', () => {
    expect(TABLE_PAGE).toMatch(/const serverStamp = stamps\.get\(String\(userId\)\)/);
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
    expect(effect).toMatch(
      /sitOutAtRef\.current\.get\(String\(userId \?\? ''\)\) \?\? Date\.now\(\)/
    );
  });
});

describe('the deadline is visible where the player is looking', () => {
  it('the seat badge is a component that can count, not a hardcoded string', () => {
    expect(SEAT_SLOT).toMatch(/<SitOutBadge sitOutAt=\{player\.sitOutAt\} \/>/);
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
    expect(TABLE_PAGE).toMatch(/const deadlinesApply = !prev\.isTournament/);
  });

  it('every countdown stops at zero instead of re-rendering forever', () => {
    /* `sitOutMsRemaining` floors at 0 rather than returning null, so anything
       keyed on "is there a deadline" stays true after expiry. Past 0:00 the
       label cannot get more urgent and there is nothing left to tick towards —
       an interval that keeps firing is a once-a-second re-render, per sat-out
       seat, for as long as the eviction sweep takes to land. */
    expect(BADGE).toMatch(/if \(next !== null && next <= 0\) clearInterval\(id\)/);
    expect(TABLE_PAGE).toMatch(/\) === 0\s*\)\s*\{\s*clearInterval\(id\);/);
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
    const decl = sliceEnclosingBlock(TABLE_PAGE, 'const heroIsSittingOut =');
    expect(TABLE_PAGE).toMatch(
      /const heroIsSittingOut =[\s\S]{0,240}sittingOutIdsRef\.current\.has\(String\(userId \?\? ''\)\)/
    );
    expect(decl.length).toBeGreaterThan(0);
  });
});
