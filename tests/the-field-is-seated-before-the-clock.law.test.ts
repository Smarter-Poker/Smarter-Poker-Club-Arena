/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE FIELD IS SEATED BEFORE THE CLOCK — LAW (Dan 2026-08-30, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim, four items in one message:
 *
 *   1. "inside the tournament cards when they load, you need to be able to
 *       scroll up or down inside all pages."
 *   2. "when a player is registered, they should be 'sat down' one minute
 *       before the event starts (doesn't happen yet)."
 *   3. "the 20k gtd did not start, or launch. currently froze instead of auto
 *       launching."
 *   4. "there needs to be a take seat button, there isn't."
 *
 * WHAT ACTUALLY HAPPENED, because it decides what these pins guard. The 20K GTD
 * Sunday $200 Deep Stack (dfae9288) DID launch: discovered at its 17:00 start,
 * 13 tables written at 17:01:19, `status` RUNNING at 17:02:10, 111 of 112
 * players seated with stacks, 79 hands dealt.
 *
 * Two separate things then went wrong, and only one of them was the engine.
 *
 * THE LOBBY CARD FROZE. It loaded once at mount and had exactly one way to
 * learn anything afterwards — a single realtime channel — so for the whole of
 * those 130 seconds it showed the REGISTERING snapshot: STARTS IN 0:00, TABLES
 * 0, ELIMINATED 0, and no control to press. A player cannot tell that apart
 * from a tournament that never started, and was not wrong to call it frozen.
 *
 * THE TABLES WERE THEN CLOSED UNDER THE FIELD by the retired World Hub legacy
 * engine, and a DB trigger released all 111 seats. That half is fixed in the
 * World Hub repo and in a migration; it is not what these pins cover.
 *
 * The four items here are one repair with four faces:
 *   - the field is SEATED one minute before the advertised start, and the cards
 *     are still dealt at the advertised start (item 2, and the 130-second hole
 *     that made item 3 possible);
 *   - the card re-reads the row on a timer, so a dead socket can no longer
 *     freeze it (item 3);
 *   - there is a TAKE SEAT button the moment a seat exists (item 4);
 *   - the details panel scrolls (item 1).
 *
 * If a pin below goes red you are re-shipping one of those. Fix the change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');

const GAME_SERVER = read('server/src/GameServer.ts');
const TM_BASE = read('server/src/tournament/TournamentManagerBase.ts');
const DETAILS = read('src/pages/tournament/TournamentDetails.tsx');
const DETAILS_CSS = read('src/pages/tournament/TournamentDetails.css');
const DOV_CSS = read('src/components/tournament/details/DetailOverviewTab.css');
const RK_CSS = read('src/components/tournament/details/RankingTab.css');
const ET_CSS = read('src/components/tournament/details/EntriesTab.css');

/** Strip block and line comments so a pin cannot pass on prose that merely
    mentions the thing it is asserting — including this file's own commentary
    about what was removed. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('ITEM 2 — the field is seated a minute before the event starts', () => {
  it('GameServer declares a one-minute pre-seat lead', () => {
    expect(GAME_SERVER).toContain('TOURNAMENT_PRESEAT_LEAD_MS');
    expect(code(GAME_SERVER)).toMatch(/const TOURNAMENT_PRESEAT_LEAD_MS\s*=\s*60_?000/);
  });

  it('the timed start gate fires at start_time MINUS the lead, not at start_time', () => {
    const gate = code(GAME_SERVER).match(/const timeReached\s*=[\s\S]{0,220}?;/)?.[0] ?? '';
    expect(gate).toContain('TOURNAMENT_PRESEAT_LEAD_MS');
    // The bare `startTime <= now` this replaced is the bug: it seated the field
    // AFTER the advertised start, which is the 130-second hole above.
    expect(gate).not.toMatch(/startTime\s*<=\s*now/);
    // The min-players requirement is not weakened by starting early.
    expect(gate).toContain('minPlayers');
  });

  it('seat-first games are untouched — their gate is bought seats, never the clock', () => {
    const seatFirst = code(GAME_SERVER).match(/const seatFirstReady\s*=[\s\S]{0,200}?;/)?.[0] ?? '';
    expect(seatFirst).toContain('paidSeats');
    expect(seatFirst).not.toContain('TOURNAMENT_PRESEAT_LEAD_MS');
  });
});

describe('ITEM 2 — seating moves, the poker does not', () => {
  const baseCode = code(TM_BASE);
  const start = baseCode.slice(
    baseCode.indexOf('async start(): Promise<void>'),
    baseCode.indexOf('async resume(): Promise<void>')
  );

  it('every table holds its deal until the advertised start_time', () => {
    expect(TM_BASE).toContain('preStartLeadMs');
    expect(start).toMatch(/holdDealingUntil\(launchStartMs\)/);
    expect(start).toMatch(/Date\.parse\(String\(tournament\.start_time/);
  });

  it('the level clock is armed after the lead, not at seating', () => {
    // A level clock armed at seating spends the first minute of level 1 on a
    // held felt, and every level after it runs a minute out of step with the
    // structure the lobby printed.
    expect(start).toMatch(
      /if\s*\(this\.preStartLeadMs\s*>\s*0\)\s*\{\s*const structure[\s\S]{0,200}?setLifecycleTimeout\([\s\S]{0,160}?startBlindTimer\(/
    );
  });

  it('started_at is the advertised start, not the seating instant', () => {
    // late_reg_mins is measured from started_at on both sides; stamping the
    // seating instant would close a 30-minute window 29 minutes in.
    expect(start).toMatch(/const requestedStartedAtIso\s*=[\s\S]{0,240}?scheduledStartMs/);
    expect(start).toMatch(/const \{ launchId, startedAtIso, supplyVersion \} = launchClaim/);
    expect(start).toMatch(/tournament\.started_at\s*=\s*startedAtIso/);
    expect(start).not.toMatch(/started_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('HORSES ARE PLAYERS (section 10.5) — the pre-seat window has no horse branch', () => {
    const window = start.slice(0, start.indexOf('holdDealingUntil') + 2000);
    expect(code(window)).not.toContain('is_horse');
    expect(code(window)).not.toContain('isHorse');
  });
});

describe('ITEM 3 — the lobby card cannot freeze', () => {
  it('the tournament row is re-read on a timer, not only over realtime', () => {
    expect(DETAILS).toMatch(/setInterval\(refresh/);
    expect(DETAILS).toMatch(/loadTournament\(undefined,\s*\{\s*quiet:\s*true\s*\}\)/);
  });

  it('the start window polls fastest, and a finished event stops polling', () => {
    expect(DETAILS).toMatch(/inStartWindow\)\s*return 3_?000/);
    expect(DETAILS).toMatch(/status === 'COMPLETED' \|\| status === 'CANCELLED'\)\s*return/);
  });

  it('a hidden tab costs nothing and refreshes when it is looked at again', () => {
    expect(DETAILS).toContain('document.hidden');
    expect(DETAILS).toContain("addEventListener('visibilitychange', onVisible)");
    expect(DETAILS).toContain("addEventListener('focus', onVisible)");
  });

  it('a quiet refresh never flashes the loading screen or toasts', () => {
    expect(DETAILS).toMatch(
      /if \(!opts\?\.quiet && \(!getIsMounted \|\| getIsMounted\(\)\)\) setIsLoading\(true\)/
    );
    expect(DETAILS).toMatch(
      /if \(!opts\?\.quiet && \(!getIsMounted \|\| getIsMounted\(\)\)\)\s*\n?\s*toast\.error/
    );
  });

  it('the realtime channel is per MOUNT, so its bindings always land pre-join', () => {
    // Two mounts of this page on one tournament (the route and the felt's
    // lobby modal) shared a channel. postgres_changes bindings added after a
    // channel has joined are silently ignored, so the second mount received
    // nothing, raised nothing, and sat on its mount-time snapshot.
    expect(DETAILS).toContain('channelInstanceRef');
    expect(DETAILS).toMatch(/`tournament-\$\{tournamentId\}-\$\{channelInstanceRef\.current\}`/);
  });

  it('tables are loaded for a LATE_REG event too, not only RUNNING', () => {
    expect(DETAILS).toMatch(/data\.status === 'RUNNING' \|\| isLateStatus\(data\.status\)/);
  });
});

describe('ITEM 4 — there is a Take Seat button', () => {
  it('the footer offers TAKE SEAT', () => {
    expect(DETAILS).toContain('TAKE SEAT');
    expect(DETAILS).toContain('btn-take-seat');
  });

  it('it appears on a table id, not on a status enum that arrives later', () => {
    // Late registration seats you at registration time while the row can still
    // read 'registered' for a beat — gating on 'playing' showed WAITING FOR
    // SEAT... over a seat the player already had.
    const branch = DETAILS.slice(DETAILS.indexOf('if (isWatchable) {'));
    expect(branch).toMatch(
      /myEntry\?\.table_id &&[\s\S]{0,160}?myEntry\.status === 'playing' \|\| myEntry\.status === 'registered'/
    );
  });
});

describe('ITEM 1 — every tab scrolls', () => {
  it('the content panel is the scroller, and is not a flex column', () => {
    const panel = code(DETAILS_CSS).match(/\.details-content \{[\s\S]*?\}/)?.[0] ?? '';
    expect(panel).toBeTruthy();
    expect(panel).toMatch(/overflow-y:\s*auto/);
    // A flex column shrinks its children to fit rather than overflowing, which
    // is exactly how a box with `overflow-y: auto` ends up with nothing to
    // scroll. This was the mechanism on the Detail, Blinds and Rewards tabs.
    expect(panel).toMatch(/display:\s*block/);
    expect(panel).not.toMatch(/overflow:\s*hidden/);
  });

  it('a tab root is content, never a viewport', () => {
    const child = code(DETAILS_CSS).match(/\.details-content > \* \{[\s\S]*?\}/)?.[0] ?? '';
    expect(child).toBeTruthy();
    expect(child).toMatch(/max-height:\s*none/);
    expect(child).toMatch(/overflow:\s*visible/);
  });

  it('the Detail tab band no longer clips what it cannot fit', () => {
    const band = code(DOV_CSS).match(/\.dov-info--band \{[\s\S]*?\}/)?.[0] ?? '';
    expect(band).toBeTruthy();
    expect(band).not.toMatch(/overflow:\s*hidden/);
    expect(band).not.toMatch(/overflow-y:\s*hidden/);
  });

  it('no list caps itself against the viewport', () => {
    // `vh` is the VIEWPORT even inside TournamentLobbyModal's 75dvh sheet, so
    // these caps belonged to a box the lists were not in: they clipped the list
    // and left the panel nothing to scroll, at the same time.
    for (const css of [RK_CSS, ET_CSS]) {
      expect(code(css)).not.toMatch(/max-height:\s*min\([^)]*vh/);
    }
  });

  it('no list holds a min-height floor open inside a scrolling panel', () => {
    expect(code(ET_CSS)).not.toMatch(/min-height:\s*1[026]0px/);
  });
});
