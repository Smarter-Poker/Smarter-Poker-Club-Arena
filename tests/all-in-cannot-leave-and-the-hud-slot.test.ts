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

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SEATING = read('server/src/engine/ServerTableEngineSeating.ts');
const BASE = read('server/src/engine/ServerTableEngineBase.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const MODALS = read('src/components/table/TableModalsLayer.tsx');
const RABBIT_CSS = read('src/components/table/RabbitHunt.css');

describe('an all-in player cannot leave the table', () => {
  it('leaveTable refuses before it does anything else', () => {
    const body = strip(SEATING);
    const at = body.indexOf('public leaveTable');
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
    expect(body.slice(at, at + 300)).toMatch(/continue;/);
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
    // The guard immediately above it is the turn context, not seat occupancy.
    expect(TABLE_PAGE.slice(at - 400, at)).toMatch(/\{isHeroTurnContext && \(/);
  });

  it('puts Rabbit Hunt in that same slot once the hand is over', () => {
    const at = TABLE_PAGE.indexOf('<TimebankCounter');
    const rabbit = TABLE_PAGE.indexOf('<RabbitHunt', at);
    const stackEnd = TABLE_PAGE.indexOf('<PreviousHandCard', at);
    expect(rabbit, 'RabbitHunt not rendered in the HUD stack').toBeGreaterThan(-1);
    // Inside the same stack, between the tile and the previous-hand card.
    expect(rabbit).toBeLessThan(stackEnd);
    expect(TABLE_PAGE).toMatch(/!tableState\.isHandInProgress && isRabbitAvailable && \(/);
  });

  it('the two conditions cannot both be true', () => {
    // One needs a hand in progress, the other needs none. No overlap logic is
    // required and none should ever be added.
    expect(TABLE_PAGE).toMatch(/isHeroTurnContext/);
    expect(TABLE_PAGE).toMatch(/!tableState\.isHandInProgress/);
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
