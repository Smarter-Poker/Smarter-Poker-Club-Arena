/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CHAMPION'S EXIT — every finisher leaves, not just the losers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, from a live table (2026-08-20): "at the end of the tournament when you
 * lose, you need to be auto removed from the table, placed inside the lobby and
 * your tournament result card shown … WINNERS SHOULD BE AUTO REMOVED AT THE END
 * AS WELL."
 *
 * Only the first half of that sentence ever worked, and the reason is the thing
 * these assertions exist to prevent coming back.
 *
 *   - `eliminatePlayer` broadcasts `player_eliminated`, TablePage hears it and
 *     moves that player to the lobby with a ranking card. Places 2..N: fine.
 *
 *   - `finishTournament` broadcast NOTHING. It paid the winner, stamped the
 *     row, released the seats, closed the tables and stopped, in silence. So
 *     the champion sat at a table that had just been closed underneath them.
 *
 * TablePage had carried a winner branch (`position === 1` -> celebration
 * overlay, then the lobby) since the day the feature shipped. It was
 * unreachable BY CONSTRUCTION and no type checker could ever say so: the only
 * event that reaches it is `player_eliminated`, and eliminatePlayer is never
 * called with place 1. The bust sweep floors basePosition at
 * `bustedOrdered.length + 1`; the unresolved-players loop uses
 * `ordered.length + 1 - i`. Both are >= 2 on purpose, so that 1st stays
 * reserved for finishTournament. Code that compiles, passes typecheck, and is
 * silently dead — the exact shape rule 4 of the anti-regression workflow is
 * about, which is why this is pinned to the EVENT NAME and the CALL, not to
 * phrasing.
 *
 * On a Spin this is the whole ending: three players, one winner, three minutes,
 * and the winner is the one who saw nothing.
 *
 * Source-level, in the house `spinEngineWiring` / `spinReserveOwnership` style:
 * the engine half needs a live Postgres and a running tournament, and TablePage
 * is a 5,000-line component wired to realtime. What is provable without either
 * is that the signal is sent, that it is heard, and that both ends still agree
 * on its name. The card that lands is covered behaviourally in
 * tests/unit/tournamentRankingHost.test.tsx.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock, sliceStatement } from '../helpers/sourceWindow';
import {
  awaitTournamentResultEnrichment,
  TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS,
} from '../../src/utils/tournamentResultEnrichment';
import type { TournamentResult } from '../../src/services/pendingSessionSummary';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Comments quote the very things these tests ban. Never match against them. */
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ELIMINATIONS = 'server/src/tournament/TournamentManagerEliminations.ts';
const TABLE_PAGE = 'src/pages/TablePage.tsx';
const REALTIME = 'src/services/RealtimeChannelService.ts';
const CLUB_HOME_PAGE = 'src/pages/ClubHomePage.tsx';
const TOURNAMENT_SERVICE = 'src/services/TournamentService.ts';

const engine = tsCode(read(ELIMINATIONS));
const tablePage = tsCode(read(TABLE_PAGE));
const realtime = tsCode(read(REALTIME));
const clubHomePage = tsCode(read(CLUB_HOME_PAGE));
const tournamentService = tsCode(read(TOURNAMENT_SERVICE));

/** The body of `goToLobbyWithResult`, from its declaration to the channel. */
function exitFnBody(): string {
  const start = tablePage.indexOf('const goToLobbyWithResult =');
  expect(start, 'goToLobbyWithResult must exist in TablePage').toBeGreaterThan(-1);
  const end = tablePage.indexOf('const breakChan =', start);
  expect(end, 'could not find the end of goToLobbyWithResult').toBeGreaterThan(start);
  return tablePage.slice(start, end);
}

/** The body of `finishTournament`, from its signature to the next method. */
function finishTournamentBody(): string {
  const start = engine.indexOf('protected async finishTournament(winnerId: string)');
  expect(start, 'finishTournament must exist in TournamentManagerEliminations').toBeGreaterThan(-1);
  const end = engine.indexOf('protected abstract checkTableBalance', start);
  expect(end, 'could not find the end of finishTournament').toBeGreaterThan(start);
  return engine.slice(start, end);
}

/** The committed normal-settlement announcement, which is also replay-safe. */
function committedCleanupBody(): string {
  const start = engine.indexOf('private async cleanupCommittedTournament()');
  expect(start, 'cleanupCommittedTournament must exist').toBeGreaterThan(-1);
  const end = engine.indexOf('private async cleanupCommittedFinalTableDeal()', start);
  expect(end, 'could not find the end of cleanupCommittedTournament').toBeGreaterThan(start);
  return engine.slice(start, end);
}

/** The shared terminal cleanup that owns channel teardown. */
function committedTableCleanupBody(): string {
  const start = engine.indexOf('private async cleanupCommittedTablesAndManager()');
  expect(start, 'cleanupCommittedTablesAndManager must exist').toBeGreaterThan(-1);
  const end = engine.indexOf('private async cleanupCommittedTournament()', start);
  expect(end, 'could not find the end of committed table cleanup').toBeGreaterThan(start);
  return engine.slice(start, end);
}

describe("The champion's exit", () => {
  it('a committed finish broadcasts the durable winner - it used to end in silence', () => {
    // THE regression. If this line goes, every champion of every event is
    // stranded again at a table the engine has already closed, and nothing
    // else in the suite notices: the payout still lands, the row is still
    // stamped, the tables still close. Only the player sees the difference.
    expect(committedCleanupBody()).toMatch(
      /this\.broadcastCommittedOutcome\(\s*['"]tournament_winner['"]/
    );
    expect(finishTournamentBody()).toMatch(/await this\.cleanupCommittedTournament\(\)/);
  });

  it('sends it BEFORE the channel is torn down', () => {
    const body = committedCleanupBody();
    const sent = body.indexOf("this.broadcastCommittedOutcome('tournament_winner'");
    const cleanup = body.indexOf('cleanupCommittedTablesAndManager()');
    expect(sent, 'tournament_winner must be broadcast').toBeGreaterThan(-1);
    expect(cleanup, 'winner cleanup must reach the shared terminal cleanup').toBeGreaterThan(-1);
    // Broadcasting after unsubscribe silently re-creates the channel and sends
    // into a subscription nobody is listening on — the failure is invisible.
    expect(sent).toBeLessThan(cleanup);
    expect(committedTableCleanupBody()).toMatch(/await this\.cleanupBroadcastChannel\(\)/);
  });

  it('carries the winner identity and the prize', () => {
    const body = committedCleanupBody();
    const payload = sliceEnclosingBlock(body, "this.broadcastCommittedOutcome('tournament_winner'");
    // TablePage matches on userId to decide whether this result is the local
    // player's; without it every seat at the table takes the champion's card.
    expect(body).toMatch(/\.select\('user_id, username, prize'\)/);
    expect(payload).toMatch(/userId:\s*winner\.user_id/);
    expect(payload).toMatch(/position:\s*1/);
    expect(payload).toMatch(/prize:\s*Number\(winner\.prize/);
  });

  it('does NOT announce the champion as eliminated', () => {
    // TournamentPage and TournamentLobbyPage both raise an elimination toast
    // on `player_eliminated`. Reusing it for place 1 would tell the whole
    // field the winner had been knocked out, so this stays its own event.
    const body = finishTournamentBody();
    expect(body).not.toMatch(/this\.broadcast\(\s*['"]player_eliminated['"]/);
  });

  it('TablePage handles tournament_winner and routes it to the lobby exit', () => {
    expect(tablePage).toMatch(/data\?\.type === 'tournament_winner'/);
    const at = tablePage.indexOf("data?.type === 'tournament_winner'");
    const branch = sliceEnclosingBlock(tablePage, "data?.type === 'tournament_winner'");
    // Only the local player leaves. Everyone else at the table is a spectator
    // of someone else's result.
    expect(branch).toMatch(/winData\.userId === userId/);
    // The celebration overlay, then the same exit every other finisher takes.
    expect(branch).toMatch(/setTournamentWinner\(/);
    expect(branch).toMatch(/goToLobbyWithResult\(1,/);
  });

  it('recovers the result from durable COMPLETED rows when every broadcast attempt fails', () => {
    const start = tablePage.indexOf('async function exitFromDurableCompletion()');
    const end = tablePage.indexOf('const breakChan =', start);
    expect(start, 'durable completion fallback must exist').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fallback = tablePage.slice(start, end);
    expect(fallback).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.select\('status, position, prize'\)/
    );
    expect(fallback).toMatch(/\['winner', 'eliminated'\]\.includes/);
    expect(fallback).toMatch(/goToLobbyWithResult\(position, prize/);
    expect(fallback).toMatch(/scheduleDurableCompletionRetry\(\)/);
    expect(tablePage).toMatch(
      /table: 'tournaments'[\s\S]*?payload\.new\?\.status === 'COMPLETED'[\s\S]*?exitFromDurableCompletion\(\)/
    );
    expect(tablePage).toMatch(
      /loadedTournamentStatus === 'COMPLETED'[\s\S]*?exitFromDurableCompletion\(\)/
    );
    expect(tablePage).toMatch(/status === 'SUBSCRIBED'[\s\S]*?verifyDurableCompletion\(\)/);
    expect(tablePage).toMatch(
      /durableCompletionRetryTimer = setTimeout\([\s\S]*?verifyDurableCompletion\(\)/
    );
  });

  it('keeps the durable completion poll armed after a successful non-terminal read', () => {
    const verify = sliceEnclosingBlock(tablePage, 'async function verifyDurableCompletion()');
    expect(verify).toMatch(
      /if \(terminal\.status === 'COMPLETED'\) \{[\s\S]*?await exitFromDurableCompletion\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?scheduleDurableCompletionRetry\(\);/
    );
  });

  it('bootstraps the durable completion backstop after the realtime channel is wired', () => {
    expect(tablePage).toMatch(
      /breakChannelRef\.current = breakChan;\s*void verifyDurableCompletion\(\);/
    );
  });

  it('re-arms the durable backstop when realtime errors or times out', () => {
    const terminalChannelCallback = sliceEnclosingBlock(tablePage, "if (status === 'SUBSCRIBED')");
    expect(terminalChannelCallback).toMatch(
      /if \(status === 'CHANNEL_ERROR'\) \{[\s\S]*?scheduleDurableCompletionRetry\(\);[\s\S]*?\}/
    );
    expect(terminalChannelCallback).toMatch(
      /if \(status === 'TIMED_OUT'\) \{[\s\S]*?scheduleDurableCompletionRetry\(\);[\s\S]*?\}/
    );
  });

  it('a committed final-table deal drives every viewer through the durable result reader', () => {
    const branch = sliceEnclosingBlock(tablePage, "data?.type === 'final_table_deal'");
    expect(branch).toMatch(/exitFromDurableCompletion\(\)/);
    expect(realtime).toMatch(/'final_table_deal'/);
  });

  it('there is exactly ONE lobby-exit implementation', () => {
    // It was declared inside the `player_eliminated` branch, which is precisely
    // why the winner had no function to call. A second copy would drift from
    // this one and only one of the two would keep getting fixed.
    const declarations = tablePage.match(/const goToLobbyWithResult\s*=/g) ?? [];
    expect(declarations.length, 'goToLobbyWithResult must be defined once').toBe(1);
    // ...and it must be hoisted above the branch chain, or the winner branch
    // cannot see it.
    expect(tablePage.indexOf('const goToLobbyWithResult =')).toBeLessThan(
      tablePage.indexOf("data?.type === 'player_eliminated'")
    );
  });

  it('a repeated broadcast cannot schedule two exits', () => {
    // A retried or duplicated broadcast used to mean two setTimeouts, two
    // publishes and two navigations. The guard lives at the subscription's
    // lifetime because a player finishes a tournament exactly once.
    const at = tablePage.indexOf('const goToLobbyWithResult =');
    const fn = sliceStatement(tablePage, 'const goToLobbyWithResult =');
    expect(fn).toMatch(/if \(exitStarted\) return;/);
    expect(fn).toMatch(/exitStarted = true;/);
  });

  it('bounds optional result enrichment before publishing and closing the table', () => {
    const fn = exitFnBody();
    expect(fn).toMatch(
      /await awaitTournamentResultEnrichment\(fetchTournamentResult\(tid, userId\)\)/
    );
    expect(fn.indexOf('await awaitTournamentResultEnrichment(')).toBeLessThan(
      fn.indexOf('publishSessionSummary(')
    );
    expect(fn.indexOf('publishSessionSummary(')).toBeLessThan(fn.indexOf("emit('TABLE_LEFT'"));
    expect(fn).toMatch(/\.\.\.\(full \?\? \{/);
    expect(fn).toMatch(/finishPlace:\s*position \|\| full\?\.finishPlace \|\| null/);
    expect(fn).toMatch(/prize:\s*prize \|\| full\?\.prize \|\| 0/);
  });

  it('the realtime event union still knows this event exists', () => {
    // Not the delivery path for the t-break channel, but it is the list the
    // next agent reads to learn what the engine emits. Letting it go stale is
    // how `broadcastWinner`/`broadcastElimination` became callerless.
    expect(realtime).toMatch(/'tournament_winner'/);
    expect(realtime).not.toMatch(/\bonWinner\b/);
    expect(realtime).not.toMatch(/case\s+['"]winner['"]/);
  });

  it('eliminatePlayer is still never called with place 1 — that is why this is needed', () => {
    // If this ever stops being true, the two paths can both fire and the
    // champion gets the card twice (or the elimination toast). The guard above
    // catches the double exit; this catches the cause.
    // 2026-08-27: both assignment sites were rewritten to walk the FREE place
    // set instead of trusting arithmetic over a live (non-monotonic) count —
    // the old `basePosition = Math.max(playingCount, ...)` and
    // `ordered.length + 1 - i` expressions this used to pin re-stamped places
    // that had already been PAID (206 duplicates across 138 tournaments).
    // The invariant this test actually cares about is unchanged and is now
    // enforced structurally: neither loop can ever hand out place 1.
    // 2026-08-28: the bust sweep's down-walk was renamed `nextPosition` ->
    // `place` when the seed moved off the live playing count and the
    // exhaustion `break` was replaced by an up-walk (Union PKO Afternoon
    // 4f42d847 deadlocked heads-up because that break left a 0-chip player
    // `status='playing'` forever, so finishTournament was unreachable). The
    // invariant is unchanged and still structural: the down-walk stops at 2,
    // and the up-walk starts ABOVE the seed, so neither can reach place 1.
    expect(engine).toMatch(/while \(place >= 2 && takenPositions\.has\(place\)\) place--;/);
    expect(engine).toMatch(/let up = nextPosition \+ 1;/);
    expect(engine).not.toMatch(/eliminatePlayer\([^)]*,\s*1\s*\)/);
    expect(engine).toMatch(/while \(finishNext >= 2 && finishTakenPositions\.has\(finishNext\)\)/);
    expect(engine).toMatch(/no_free_finishing_place/);
  });
});

describe('The tournament result lookup cannot strand an exit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('continues after the deadline when the lookup never resolves', async () => {
    expect(TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    let continuedToExit = false;
    const neverResolvingLookup = new Promise<TournamentResult>(() => {});
    const exit = (async () => {
      const result = await awaitTournamentResultEnrichment(
        neverResolvingLookup,
        TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS
      );
      continuedToExit = true;
      return result;
    })();

    await vi.advanceTimersByTimeAsync(TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS - 1);
    expect(continuedToExit).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(exit).resolves.toBeUndefined();
    expect(continuedToExit).toBe(true);
  });

  it('uses enrichment that arrives inside the budget', async () => {
    const result: TournamentResult = {
      finishPlace: 2,
      entrants: 84,
      prize: 125,
      bountyWinnings: 15,
      knockouts: 3,
      rebuys: 0,
      addOns: 0,
      isSpin: false,
    };
    const lookup = new Promise<TournamentResult>((resolveLookup) => {
      setTimeout(() => resolveLookup(result), 100);
    });

    const enriched = awaitTournamentResultEnrichment(lookup);
    await vi.advanceTimersByTimeAsync(100);

    await expect(enriched).resolves.toEqual(result);
  });

  it('also falls through when an unexpected lookup rejection escapes', async () => {
    await expect(
      awaitTournamentResultEnrichment(Promise.reject(new Error('transport failed')))
    ).resolves.toBeUndefined();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ...AND THE EXIT ACTUALLY LEAVES (audit, 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sending the signal fixed "the winner is never told". It did not fix "the
 * winner never leaves". `goToLobbyWithResult` published the card and navigated,
 * and that was the whole of it — while every manual leave in TablePage sends
 * four more signals, none of which fired for a tournament finisher. So the
 * table they had been kicked from stayed in their tab bar and their status kept
 * saying they were sitting at it.
 *
 * Worse in multi-table, where TablePage runs as up to four embedded instances:
 * an unconditional navigate from one of them tears down the container and takes
 * the other three LIVE tables with it.
 */
describe('The exit actually leaves the table', () => {
  it('sends the four signals every manual leave sends', () => {
    const fn = exitFnBody();
    // Each of these had a manual-leave counterpart and no tournament one.
    expect(fn, 'SESSION_ENDED').toMatch(/masterBus\.emit\('SESSION_ENDED'/);
    expect(fn, 'clearPlayingAt').toMatch(/playerStatusService\.clearPlayingAt\(userId\)/);
    expect(fn, 'TABLE_LEFT').toMatch(/masterBus\.emit\('TABLE_LEFT'/);
    expect(fn, 'CLOSE_TABLE_TAB').toMatch(/action: 'CLOSE_TABLE_TAB'/);
  });

  it('publishes the card BEFORE it starts tearing the table down', () => {
    // The app-root host reads the payload on arrival. Emitting TABLE_LEFT
    // first starts unmounting this instance while the result is still in hand.
    const fn = exitFnBody();
    expect(fn.indexOf('publishSessionSummary(')).toBeLessThan(fn.indexOf("emit('TABLE_LEFT'"));
  });

  it('does NOT navigate when it is embedded in MultiTablePage', () => {
    /* THE regression this guards. Four tables, one finishes, and an
       unconditional navigate tears down the container — the other three go
       with it, mid-hand. MultiTablePage subscribes to TABLE_LEFT and
       CLOSE_TABLE_TAB, removes just that tab, and calls goToLobby() itself
       only when it was the last one. */
    const fn = exitFnBody();
    const guard = fn.indexOf('if (embeddedTableId) return;');
    expect(guard, 'the embedded guard must be present').toBeGreaterThan(-1);
    // ...and it must come BEFORE both navigate calls, or it guards nothing.
    const firstNavigate = fn.indexOf('navigate(`/');
    expect(firstNavigate).toBeGreaterThan(guard);
  });

  it('guards on embeddedTableId, not on isMultiTable', () => {
    /* `isMultiTable` is a sound/UX flag: MultiTablePage passes
       `tables.length > 1 || hidden`, so it is FALSE for a single visible table
       while the container is still mounted and still subscribed. Branching on
       it would leave the commonest case with two navigators racing for the
       destination. `embeddedTableId` is set exactly when this instance lives
       inside the container, which is the actual question being asked. */
    expect(exitFnBody()).not.toMatch(/if \(isMultiTable\) return;/);
  });

  it('cancels a pending exit when the subscription is torn down', () => {
    // The winner's beat is 7s. A player moved off this tab inside it used to be
    // force-navigated out of wherever they had gone.
    expect(exitFnBody()).toMatch(/tournamentExitTimerRef\.current = setTimeout\(/);
    expect(tablePage).toMatch(/clearTimeout\(tournamentExitTimerRef\.current\)/);
  });
});

describe('One card, one carrier', () => {
  it('no lobby page reads a result out of router state', () => {
    /* It could never work: the state was addressed to `/clubs/:clubId`
       (ClubHomePage) and only `/clubs/:clubId/lobby` read it, so the card was
       dropped on arrival every time. No route-level reader can cover "the
       lobby" — which is why the app-root host exists.

       ClubLobby.tsx, the page this case was written against, was deleted on
       2026-08-23: /clubs/:clubId/lobby now renders ClubHomePage, so there is
       one lobby component instead of two. The rule is unchanged and now
       points at the page that survived. */
    expect(clubHomePage).not.toMatch(/TournamentResultCard/);
    expect(clubHomePage).not.toMatch(/location\.state[^\n]*tournamentResult/);
  });

  it('the client cannot announce an elimination or a winner', () => {
    /* Both are the engine's to decide. A second publisher on the same channel
       is how a table acts on a result the database disagrees with — and
       `broadcastWinner` sitting here unused is exactly what made "nothing
       announces the winner" so easy to miss. */
    expect(tournamentService).not.toMatch(/async broadcastWinner\(/);
    expect(tournamentService).not.toMatch(/async broadcastElimination\(/);
  });

  it('the card is branded a Spin only when it IS one', () => {
    // It said SPIN unconditionally, so a 128-runner MTT finished under a Spin
    // badge. Resolved from the tournament row, never from the event name.
    const card = tsCode(read('src/components/tournament/TournamentRankingCard.tsx'));
    /**
     * Dan 2026-08-23: "remove the 'spin' after SmarterPoker". The badge used
     * to read `result.isSpin ? 'SPIN' : 'TOURNAMENT'`; on a Spin it repeated
     * what the event line directly beneath it already said. A Spin now carries
     * NO badge, and only a real tournament is badged — a stricter version of
     * what this test has always guarded: the card must never label a game as
     * something it is not.
     */
    expect(card).not.toMatch(/'SPIN'/);
    expect(card).toMatch(/!result\.isSpin && <span className="trc2__brand-mark">TOURNAMENT/);
    expect(tablePage).toMatch(/isSpin: isSpinTournament\(/);
    // isSpinTournament reads both columns; both must be selected or it is
    // always false.
    //
    // 2026-08-25: the same select now also carries `is_mystery_bounty`, which
    // gates the mystery bounty read that fills the card's chest figures
    // (Dan section 43). What this test guards is unchanged and is asserted on
    // the two columns by name rather than on the whole literal, so the next
    // column added here does not fail a spec about Spin branding.
    expect(tablePage).toMatch(/select\('name, current_players, variant, tournament_type/);
    expect(tablePage).toMatch(/select\('name, current_players, variant, tournament_type[^']*'\)/);
  });
});
