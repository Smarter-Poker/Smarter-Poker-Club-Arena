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
const CHAT_CSS = read('src/components/table/TableChat.css');
const TABLE_CSS = read('src/pages/TablePage.css');

/** The one tile size. 44px from 2026-08-28; 66px since 2026-09-04 (Dan: "the
 *  previous hand, chat, time bank, and rabbit hunt buttons all need to be 50%
 *  larger"). Change it here and in TableHUD.css together. */
const TILE = 40;
const TILE_RADIUS = 10;

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

/*
 * SUPERSEDED 2026-10-25 for the player, kept for the seat. Dan: "IF A USER
 * CLICKS LEAVE GAME, IT NEEDS TO LEAVE GAME RIGHT AWAY, NOT THE NEXT HAND OR IN
 * A COUPLE HANDS, LEAVE NOW, EVEN IF ITS IN THE MIDDLE OF A HAND." and
 * "AVATARS SHOULD NOT LEAVE THE TABLE UNTIL AFTER THEIR ACTION IS COMPLETED."
 * The all-in refusal sent the player to the lobby with the seat still live, to
 * be dealt the next hand and the one after. Now the leave is accepted and
 * recorded at once, and the all-in SEAT still plays its hand out (the 08-26
 * rule's purpose) before settlement cashes it out. Behaviour is driven in
 * server/src/engine/LeaveMeansNow.behaviour.test.ts.
 */
describe('an all-in player leaves now; the seat finishes the hand', () => {
  it('leaveTable no longer refuses an all-in player', () => {
    expect(SEATING).not.toMatch(/You Are All In\. You Cannot Leave Until The Hand Is Finished\./);
    expect(SEATING).not.toMatch(/refusing leave for \$\{userId\} - all-in in a live hand/);
  });

  it('an all-in seat is never folded and never shown sitting out while its hand is live', () => {
    const body = strip(SEATING);
    const fold = body.slice(body.indexOf('protected foldLeaverNow'));
    expect(fold).toMatch(/if \(seatPlayer\.is_all_in\) return true;/);
    expect(body).toMatch(/this\.pendingSitOut\.add\(userId\);/);
  });

  it('the eviction sweep still will not stand up an all-in player', () => {
    const body = strip(BASE);
    expect(body).toMatch(/evictSelf\?\.is_all_in && !evictSelf\.is_folded/);
    expect(sliceEnclosingBlock(body, 'evictSelf?.is_all_in')).toMatch(/continue;/);
  });

  it('is_all_in is still only read from the live hand, not a stale seat row', () => {
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
    // 2026-09-04: `heroPromptedToAct` is isHeroTurnContext minus the turns
    // the engine is taking for the player (armed pre-action) - still the
    // turn context, never seat occupancy.
    expect(strip(TABLE_PAGE)).toMatch(/tableHudControl\(\{\s*heroPromptedToAct,/);
    expect(strip(TABLE_PAGE)).toMatch(
      /const heroPromptedToAct = isHeroTurnContext && !suppressPanelForPreAction;/
    );
  });

  it('puts Rabbit Hunt in that same slot once the hand is over', () => {
    const at = TABLE_PAGE.indexOf('<TimebankCounter');
    const rabbit = TABLE_PAGE.indexOf('<RabbitHunt', at);
    const stackEnd = TABLE_PAGE.indexOf('<PreviousHandCard', at);
    expect(rabbit, 'RabbitHunt not rendered in the HUD stack').toBeGreaterThan(-1);
    // Inside the same stack, between the tile and the previous-hand card.
    expect(rabbit).toBeLessThan(stackEnd);
    expect(TABLE_PAGE.slice(0, rabbit)).toMatch(/\{hudSlotControl === 'rabbit' && \(/);
    // The authoritative completion event may precede the hand-free snapshot.
    // Runtime boundary tests in tableHudControl.test.ts pin immediate offers,
    // stale-turn suppression, and priority of a real next-hand decision.
    expect(strip(TABLE_PAGE)).toMatch(
      /handSettling,\s*handInProgress: tableState\.isHandInProgress,\s*rabbitAvailable: isRabbitAvailable && rabbitViewIsCurrent,/
    );
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
    expect(body).toMatch(
      /const hudSlotControl: 'timebank' \| 'rabbit' \| null = tableHudControl\(/
    );
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
    expect(strip(HUD_CSS)).toMatch(/--sp-hud-tile-size:\s*var\(--sp-game-tool-size, 40px\)/);
    expect(strip(HUD_CSS)).toMatch(new RegExp(`--sp-hud-tile-radius:\\s*${TILE_RADIUS}px`));
  });

  it('the chat button is the same tile, written in its own stylesheet', () => {
    // .chat-collapsed is mounted outside .table-hud (TablePage.tsx renders it
    // beside the HUD, not inside it), so it cannot read the token and carries
    // the literal. Dan 2026-08-28 asked for the four to be one size; this is
    // what keeps a token change from leaving the chat bubble behind.
    const btn = ruleBody(CHAT_CSS, '.chat-collapsed');
    expect(btn).toMatch(/width:\s*var\(--sp-game-tool-size, 40px\)/);
    expect(btn).toMatch(/height:\s*var\(--sp-game-tool-size, 40px\)/);
    expect(btn).toMatch(new RegExp(`border-radius:\\s*${TILE_RADIUS}px`));
    const img = ruleBody(CHAT_CSS, '.chat-collapsed__icon-img');
    expect(img).toMatch(/width:\s*var\(--sp-game-tool-size, 40px\)/);
    expect(img).toMatch(/height:\s*var\(--sp-game-tool-size, 40px\)/);
  });

  it('no breakpoint re-sizes a tile through a phantom token', () => {
    // PreviousHandCard.css carried a `@media (min-width: 1024px)` block that
    // read `--sp-hud-tile-size-lg`, declared nowhere, so its 44px fallback
    // silently became the desktop size the moment the base token moved.
    for (const [name, css] of SLOT_WIDGETS) {
      expect(strip(css), `${name} reads an undeclared -lg tile token`).not.toMatch(
        /--sp-hud-tile-(?:size|radius)-lg/
      );
    }
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

  it('--sp-hero-clear is still the half-seat floor and was not grown to fit the tiles', () => {
    // Until 2026-09-04 this asserted hero-clear >= TILE + LINE: the corner row
    // had to fit inside the hero's strip. At 66px the row (74px with the line)
    // is taller than the strip on purpose - the reserve is the HERO's (half a
    // seat, 50px floor) and every time an agent grew it to fit chrome the felt
    // shrank, which Dan has rejected three times (TablePage.css, the
    // --sp-hero-clear derivation). The tiles sit at the page's left edge under
    // the stadium's rounded corner, where the oval leaves that room empty.
    // So the pin inverts: the desktop reserve stays the measured half-seat
    // number, and nobody may quietly raise it to chase the tile.
    // Short six-seat phones reserve four more pixels for the hero plate,
    // as measured with the ticker and safe area. It is permanent and scoped;
    // it must never become a HUD-sized or hand-state reserve.
    const shortPhone = strip(TABLE_CSS).match(
      /@media\s*\(max-width:\s*375px\)\s*and\s*\(max-height:\s*700px\)\s*and\s*\(orientation:\s*portrait\)\s*\{\s*\.table-page\[data-seats='6'\]\s+\.table-container\s*\{\s*--sp-hero-clear:\s*64px;\s*\}/
    );
    expect(
      shortPhone,
      'the measured short-phone hero clearance must remain narrowly scoped'
    ).toBeTruthy();
    // Equal compact pods on short phones return six unused pixels to the
    // felt; six-max retains its existing extra four pixels for ticker clearance.
    const compactRing = strip(TABLE_CSS).match(
      /@media\s*\(min-width:\s*341px\)\s*and\s*\(max-width:\s*480px\)\s*and\s*\(max-height:\s*720px\)\s*and\s*\(orientation:\s*portrait\)\s*\{\s*\.table-page\s+\.table-container\s*\{\s*--sp-hero-clear:\s*54px;\s*\}\s*\.table-page\[data-seats='6'\]\s+\.table-container\s*\{\s*--sp-hero-clear:\s*58px;\s*\}\s*\}/
    );
    expect(compactRing, 'the compact shared-pod reserve stays scoped to short phones').toBeTruthy();
    const declared = [
      ...strip(TABLE_CSS)
        .replace(shortPhone![0], '')
        .replace(compactRing![0], '')
        .matchAll(/--sp-hero-clear:\s*(\d+)px/g),
    ].map((m) => Number(m[1]));
    // All other reserves stay derived. Parse actual CSS, not historical
    // comments that happened to quote a 60px declaration.
    expect(declared, 'an unscoped flat hero reserve was introduced').toEqual([]);
    const HALF_SEAT_DESKTOP = 60;
    // Dan 2026-10-22, desktop: "the bottom user display gets cut off by the
    // action bar." A flat 60px only covered the smallest felt, so the desktop
    // strip is SOLVED from the hero plate's own overhang (a tenth of the felt's
    // width plus 27px) with 60px as its floor. It is still the hero's half seat
    // and nothing else: no tile or HUD term may enter it.
    const desk = TABLE_CSS.match(/--sp-hero-clear:\s*max\(\s*(\d+)px,\s*min\(([\s\S]*?)\)\s*\);/);
    expect(desk, 'the desktop --sp-hero-clear derivation is missing').toBeTruthy();
    expect(Number(desk![1]), 'the desktop floor moved off the half seat').toBe(HALF_SEAT_DESKTOP);
    expect(desk![2]).toContain(
      '0.0605 * (var(--sp-page-h) - var(--sp-table-top) - var(--sp-action-reserve))'
    );
    expect(desk![2]).toContain('calc(10vw + 33px)');
    expect(desk![2]).not.toMatch(/tile|tdock|hud/i);
    // And the phone reserve is still proportional to the width, not a flat
    // number sized to the tile. Dan 2026-10-22: the phone plate hangs a tenth
    // of the width plus 27px below the felt; 6px of air on top of that.
    expect(TABLE_CSS).toMatch(/--sp-hero-clear:\s*max\(\s*56px,\s*min\(\s*calc\(10vw \+ 33px\),/);
  });
});
