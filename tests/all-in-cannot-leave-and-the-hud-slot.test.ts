/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ALL-IN PLAYERS STAY, AND ONE HUD SLOT HOLDS TWO CONTROLS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26, three rules in one message:
 *
 *   "in cash games or tournaments, a player can never leave the table while
 *    they are all in. they must wait for the hand to be finished."
 *
 *   "TIME BANK ICON SHOULD ONLY APPEAR WHEN ITS THE USERS TURN TO ACT, IT
 *    SHOULDN'T BE DISPLAYED THERE ALL THE TIME."
 *
 *   "THAT ALSO THE EXACT POSITION THAT THE RABBIT HUNT BUTTON SHOULD APPEAR
 *    WHEN THE HAND IS OVER."
 *
 * ── LEAVING WHILE ALL-IN ─────────────────────────────────────────────────────
 *
 * `is_all_in` was already read on both leave branches - and only ever to SKIP
 * THE AUTO-FOLD:
 *
 *     if (enginePlayer && !enginePlayer.is_folded && !enginePlayer.is_all_in)
 *
 * having skipped it, the code carried on leaving. So an all-in player was
 * marked sitting_out in a live pot and the client navigated them away
 * mid-runout, off a hand they had every chip in.
 *
 * The refusal goes at the TOP of leaveTable(), before the roster lookup and
 * before the cash/tournament split, because that function is the single
 * chokepoint for HTTP /leave, the admin kick and the horse rotator. One check
 * closes all three for both table types. A folded player may still go: their
 * chips are out of the pot.
 *
 * The sit-out / away-blind / nit eviction sweep gets the same guard. Both of
 * its call sites are between hands today, so it should never fire - which is
 * exactly why it needed one: the safety was call-site placement, not a check.
 *
 * `is_all_in` is ENGINE MEMORY, not a table_seats column (verified against
 * production: table_seats has no such column). So the guard cannot live in the
 * database, and the engine-down branch of the /leave handler is a genuine
 * bypass - documented there rather than papered over, because with no engine
 * there is no dealing loop and therefore no live hand to be all-in in.
 *
 * ── THE HUD SLOT ─────────────────────────────────────────────────────────────
 *
 * The time bank tile rendered on `heroSeat > 0` alone: present for every hand,
 * every orbit, whether or not it could be used. It now needs the hero to be on
 * the clock.
 *
 * Rabbit Hunt used to render from TableModalsLayer with `position: fixed; left:
 * 12px; bottom: 22vh` plus a 480px override - its own coordinate system, chosen
 * to approximate the bottom-left corner, drifting from the HUD's real bottom
 * line whenever the action panel changed height. It renders from the same HUD
 * stack now and its self-positioning is gone.
 *
 * The two conditions are mutually exclusive by construction: the tile needs a
 * hand in progress with the hero to act, Rabbit Hunt needs no hand in progress.
 * One slot, no overlap logic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SEATING = read('server/src/engine/ServerTableEngineSeating.ts');
const BASE = read('server/src/engine/ServerTableEngineBase.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const MODALS = read('src/components/table/TableModalsLayer.tsx');
const RABBIT_CSS = read('src/components/table/RabbitHunt.css');
const TBC_CSS = read('src/components/table/TimebankCounter.css');
const PREV_CSS = read('src/components/table/PreviousHandCard.css');
const HUD_CSS = read('src/components/table/TableHUD.css');
const TABLE_CSS = read('src/pages/TablePage.css');

/** The declaration block of the first rule whose selector is exactly `sel`. */
const ruleBody = (css: string, sel: string) => {
  const bare = strip(css);
  const at = bare.indexOf(`${sel} {`);
  if (at < 0) throw new Error(`rule ${sel} not found`);
  return bare.slice(at, bare.indexOf('}', at));
};

/**
 * Every widget that can stand in the bottom-left HUD corner, and the rule that
 * sizes it. `--sp-hero-clear` reserves the felt's bottom strip from ONE tile
 * size, so all three of these have to be that one size or the reserve is a
 * guess. See the note above `--sp-hero-clear` in TablePage.css.
 */
const SLOT_WIDGETS: Array<[string, string, string]> = [
  ['TimebankCounter.css', TBC_CSS, '.tbc-widget'],
  ['PreviousHandCard.css', PREV_CSS, '.prev-hand-card'],
  ['RabbitHunt.css', RABBIT_CSS, '.rabbit-hunt__button'],
];

describe('an all-in player cannot leave the table', () => {
  it('leaveTable refuses before it does anything else', () => {
    const body = strip(SEATING);
    // `public async leaveTable(` since chip continuity (2026-09-04): the
    // between-hands answer is awaited from the database.
    const at = body.indexOf('public async leaveTable');
    expect(at).toBeGreaterThan(-1);

    const guard = body.indexOf('liveSelf?.is_all_in', at);
    const rosterLookup = body.indexOf('this.seatedPlayers.find', at);
    const tournamentSplit = body.indexOf('this.isTournamentTable()', at);

    expect(guard, 'no all-in guard in leaveTable').toBeGreaterThan(-1);
    // Before the roster lookup, so a player missing from the hand roster cannot
    // slip past on the "reserved seat" ack.
    expect(guard).toBeLessThan(rosterLookup);
    // And before the cash/tournament split, so it covers both.
    expect(guard).toBeLessThan(tournamentSplit);
  });

  it('says so in words a player can read', () => {
    expect(SEATING).toMatch(/You Are All In\. You Cannot Leave Until The Hand Is Finished\./);
  });

  it('lets a folded player go, because their chips are out of the pot', () => {
    expect(SEATING).toMatch(/liveSelf\?\.is_all_in && !liveSelf\.is_folded/);
  });

  it('the eviction sweep will not stand up an all-in player either', () => {
    const body = strip(BASE);
    expect(body).toMatch(/evictSelf\?\.is_all_in && !evictSelf\.is_folded/);
    // It skips that player and keeps evicting the rest, rather than aborting
    // the whole sweep.
    const at = body.indexOf('evictSelf?.is_all_in');
    expect(sliceEnclosingBlock(body, 'evictSelf?.is_all_in')).toMatch(/continue;/);
  });

  it('is_all_in is still only read from the live hand, not a stale seat row', () => {
    // table_seats has no all_in column; the flag lives in HandController state
    // and is rebuilt each hand.
    expect(SEATING).toMatch(/this\.handController\?\.getState\(\)/);
    expect(SEATING).toMatch(/liveHand\?\.players\.find/);
  });
});

describe('the bottom-left HUD slot', () => {
  it('shows the time bank only when the hero is on the clock', () => {
    expect(strip(TABLE_PAGE)).not.toMatch(/\{tableState\.heroSeat > 0 && \(\s*<TimebankCounter/);
    const at = TABLE_PAGE.indexOf('<TimebankCounter');
    expect(at).toBeGreaterThan(-1);
    // The guard immediately above it is the slot decision, and the slot's
    // 'timebank' branch is the turn context — not seat occupancy.
    expect(TABLE_PAGE.slice(at - 400, at)).toMatch(/\{hudSlotControl === 'timebank' && \(/);
    expect(strip(TABLE_PAGE)).toMatch(/isHeroTurnContext\s*\n?\s*\?\s*'timebank'/);
  });

  it('puts Rabbit Hunt in that same slot once the hand is over', () => {
    const at = TABLE_PAGE.indexOf('<TimebankCounter');
    const rabbit = TABLE_PAGE.indexOf('<RabbitHunt', at);
    const stackEnd = TABLE_PAGE.indexOf('<PreviousHandCard', at);
    expect(rabbit, 'RabbitHunt not rendered in the HUD stack').toBeGreaterThan(-1);
    // Inside the same stack, between the tile and the previous-hand card.
    expect(rabbit).toBeLessThan(stackEnd);
    expect(TABLE_PAGE.slice(0, rabbit)).toMatch(/\{hudSlotControl === 'rabbit' && \(/);
    // And it still requires that no hand be in progress. This is NOT redundant
    // with the branch order: a reveal freezes the engine snapshot for 3s and
    // paints cards onto the live board, so the gate is a safety rule about the
    // REVEAL, not only about who gets the slot.
    expect(strip(TABLE_PAGE)).toMatch(/!tableState\.isHandInProgress && isRabbitAvailable/);
  });

  it('the slot is filled by one control chosen in one place, not by two conditions', () => {
    // UPDATED 2026-08-27. This used to assert only that both expressions existed
    // and reason, in a comment, that they could not overlap. They could not —
    // by an accident of how each was written, two months apart, with nothing
    // declaring the invariant and nothing stopping either from being widened.
    // The corner's whole height budget (--sp-hero-clear) assumes exactly one
    // tile stands here, so the guarantee is now structural: a ternary chain
    // yields one value, which makes two controls in one slot unrepresentable.
    const body = strip(TABLE_PAGE);
    expect(body).toMatch(/const hudSlotControl: 'timebank' \| 'rabbit' \| null/);
    // Exactly one render site each, and both read the decision rather than
    // recomputing it.
    expect(body.match(/hudSlotControl === 'timebank'/g)).toHaveLength(1);
    expect(body.match(/hudSlotControl === 'rabbit'/g)).toHaveLength(1);
    // The time bank wins the slot: the hero is on the clock, and the Rabbit
    // Hunt offer survives being displaced (the server holds it 90s).
    expect(body.indexOf("? 'timebank'")).toBeLessThan(body.indexOf("? 'rabbit'"));
    // No second, independent gate may render either widget.
    expect(body).not.toMatch(/\{isHeroTurnContext && \(\s*<TimebankCounter/);
    expect(body).not.toMatch(/isRabbitAvailable && \(\s*<RabbitHunt/);
  });

  it('Rabbit Hunt no longer renders from the modals layer', () => {
    expect(strip(MODALS)).not.toMatch(/<RabbitHunt/);
    // And its four forwarding props went with it rather than being threaded
    // through a component that no longer renders the thing.
    expect(strip(MODALS)).not.toMatch(/onRabbitReveal/);
    expect(strip(MODALS)).not.toMatch(/rabbitCardsAvailable/);
  });

  it('Rabbit Hunt no longer positions itself in its own coordinate system', () => {
    const css = RABBIT_CSS.slice(RABBIT_CSS.indexOf('.rabbit-hunt {'));
    const rootRule = css.slice(0, css.indexOf('}'));
    expect(rootRule).not.toMatch(/position:\s*fixed/);
    expect(rootRule).not.toMatch(/bottom:\s*\d+vh/);
  });

  it('but keeps pointer-events, which the HUD makes load-bearing', () => {
    // .table-hud sets pointer-events: none so the felt stays touchable; every
    // interactive child has to opt back in or the button is unclickable.
    const css = RABBIT_CSS.slice(RABBIT_CSS.indexOf('.rabbit-hunt {'));
    expect(css.slice(0, css.indexOf('}'))).toMatch(/pointer-events:\s*auto/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SAME POSITION MEANS SAME BOX (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "it should appear in the same position that the time bank icon lives."
 *
 * Rendering into the time bank's slot was done in #1327 and was only half of it.
 * `.rabbit-hunt__button` was still a hardcoded 64px square (54px under 480px)
 * standing in a corner of 36px tiles, so the corner grew by 28px the moment a
 * hand ended and the button overhung the felt's bottom edge — `--sp-hero-clear`
 * reserves that strip from ONE tile size. It was in the right place and the
 * wrong shape, which is what "not in the same position" looked like on screen.
 *
 * These pin the mechanism, not a pixel: the size lives in TableHUD.css as a
 * token and all three widgets read it. A widget that declares its own square is
 * the bug, whatever number it picks.
 */
describe('every widget in the bottom-left HUD corner is the same tile', () => {
  it('the size is declared once, on .table-hud, as a token', () => {
    // 44px since 2026-08-28 (Dan: same size as the chat button); 66px since
    // 2026-09-04 (Dan: "PREVIOUS HANDS, CHAT, LOBBY BUTTON (FOR TOURNAMENTS)
    // AND RABBIT HUNT BUTTONS ALL NEED TO BE 50% LARGER"). The chat button
    // in TableChat.css is the same 66px, so the two corners still match.
    expect(strip(HUD_CSS)).toMatch(/--sp-hud-tile-size:\s*66px/);
    expect(strip(HUD_CSS)).toMatch(/--sp-hud-tile-radius:\s*18px/);
    const chat = ruleBody(read('src/components/table/TableChat.css'), '.chat-collapsed');
    expect(chat).toMatch(/width:\s*66px/);
    expect(chat).toMatch(/height:\s*66px/);
  });

  it('the previous-hand tile has no desktop-only size of its own', () => {
    // A `min-width: 1024px` block used to re-size .prev-hand-card from a
    // `--sp-hud-tile-size-lg` token that nothing declares, so the 44px
    // fallback would have held the desktop tile at 44 while the real token
    // moved to 66. One token, every width.
    expect(strip(PREV_CSS)).not.toMatch(/--sp-hud-tile-size-lg/);
  });

  it('all three read that token for width and height', () => {
    for (const [name, css, sel] of SLOT_WIDGETS) {
      const rule = ruleBody(css, sel);
      expect(rule, `${name} ${sel} does not read --sp-hud-tile-size for width`).toMatch(
        /width:\s*var\(--sp-hud-tile-size/
      );
      expect(rule, `${name} ${sel} does not read --sp-hud-tile-size for height`).toMatch(
        /height:\s*var\(--sp-hud-tile-size/
      );
    }
  });

  it('none of them hardcodes a pixel square', () => {
    for (const [name, css, sel] of SLOT_WIDGETS) {
      const rule = ruleBody(css, sel);
      expect(rule, `${name} ${sel} hardcodes a size`).not.toMatch(/(?:^|\s)(?:width|height):\s*\d/);
    }
    // And no breakpoint may quietly put one back. This is how Rabbit Hunt's
    // 54px override survived the move into the slot.
    expect(strip(RABBIT_CSS), 'RabbitHunt.css still carries its old 64/54px square').not.toMatch(
      /\b(?:64|54)px\b/
    );
  });

  it('and the same radius, background and touch target, so the corner reads as a set', () => {
    for (const [name, css, sel] of SLOT_WIDGETS) {
      const rule = ruleBody(css, sel);
      expect(rule, `${name} ${sel} does not use the tile radius`).toMatch(
        /border-radius:\s*var\(--sp-hud-tile-radius/
      );
      expect(rule, `${name} ${sel} does not use the tile background`).toMatch(
        /background:\s*var\(--sp-hud-tile-bg/
      );
      // 36px painted, 44px touched — the pseudo-element that grows the hit area
      // without moving a pixel of layout. Same insets in all three or a tap on
      // the seam behaves differently depending on which control is in the slot.
      expect(strip(css), `${name} has no 44px touch target`).toMatch(/inset:\s*-3px\s+-4px/);
    }
  });

  it('the corner is a row, so two tiles side by side is the whole of its footprint', () => {
    // Until 2026-09-04 this test held `--sp-hero-clear >= tile + line`, on the
    // reasoning that the corner had to fit under the felt's bottom edge. That
    // reserve is for the HERO, who hangs off the CENTRE of the oval; the
    // tiles stand in the CORNERS. Measured in the felt harness with the real
    // stylesheets (see the note on --sp-hud-tile-size in TableHUD.css), the
    // felt's bottom edge is 98-117px above the action bar on every device,
    // so a 74px row never reaches it. What the row must NOT do is grow DOWN
    // into a column again - a column of 66px tiles would be 140px tall and
    // would reach the hero's plate. The row is what makes two 66px tiles
    // cost the hero nothing: the rabbit tile ends at x=142 and the hero
    // avatar starts at x=152 (375) / 154 (390) / 170 (430).
    const row = ruleBody(TABLE_CSS, '.hud-bl-row');
    expect(row).toMatch(/flex-direction:\s*row/);
    expect(row).toMatch(/align-items:\s*flex-end/);
    // And the previous-hand tile stays at the anchor, the shared slot beside it.
    expect(strip(TABLE_CSS)).toMatch(
      /\.hud-bl-row \.prev-hand-card-wrapper,\s*\.hud-bl-row \.prev-hand-card \{\s*order:\s*0/
    );
  });
});
