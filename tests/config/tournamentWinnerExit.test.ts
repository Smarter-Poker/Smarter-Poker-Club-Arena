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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Comments quote the very things these tests ban. Never match against them. */
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ELIMINATIONS = 'server/src/tournament/TournamentManagerEliminations.ts';
const TABLE_PAGE = 'src/pages/TablePage.tsx';
const REALTIME = 'src/services/RealtimeChannelService.ts';

const engine = tsCode(read(ELIMINATIONS));
const tablePage = tsCode(read(TABLE_PAGE));
const realtime = tsCode(read(REALTIME));

/** The body of `finishTournament`, from its signature to the next method. */
function finishTournamentBody(): string {
  const start = engine.indexOf('protected async finishTournament(winnerId: string)');
  expect(start, 'finishTournament must exist in TournamentManagerEliminations').toBeGreaterThan(-1);
  const end = engine.indexOf('protected abstract checkTableBalance', start);
  expect(end, 'could not find the end of finishTournament').toBeGreaterThan(start);
  return engine.slice(start, end);
}

describe("The champion's exit", () => {
  it('finishTournament broadcasts the winner — it used to end in silence', () => {
    // THE regression. If this line goes, every champion of every event is
    // stranded again at a table the engine has already closed, and nothing
    // else in the suite notices: the payout still lands, the row is still
    // stamped, the tables still close. Only the player sees the difference.
    expect(finishTournamentBody()).toMatch(/this\.broadcast\(\s*['"]tournament_winner['"]/);
  });

  it('sends it BEFORE the channel is torn down', () => {
    const body = finishTournamentBody();
    const sent = body.indexOf("this.broadcast('tournament_winner'");
    const teardown = body.indexOf('cleanupBroadcastChannel()');
    expect(sent, 'tournament_winner must be broadcast').toBeGreaterThan(-1);
    expect(teardown, 'finishTournament must still clean up its channel').toBeGreaterThan(-1);
    // Broadcasting after unsubscribe silently re-creates the channel and sends
    // into a subscription nobody is listening on — the failure is invisible.
    expect(sent).toBeLessThan(teardown);
  });

  it('carries the winner identity and the prize', () => {
    const body = finishTournamentBody();
    const at = body.indexOf("this.broadcast('tournament_winner'");
    const payload = body.slice(at, at + 400);
    // TablePage matches on userId to decide whether this result is the local
    // player's; without it every seat at the table takes the champion's card.
    expect(payload).toMatch(/userId:\s*winnerId/);
    expect(payload).toMatch(/position:\s*1/);
    expect(payload).toMatch(/prize:\s*winnerPrize/);
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
    const branch = tablePage.slice(at, at + 900);
    // Only the local player leaves. Everyone else at the table is a spectator
    // of someone else's result.
    expect(branch).toMatch(/winData\.userId === userId/);
    // The celebration overlay, then the same exit every other finisher takes.
    expect(branch).toMatch(/setTournamentWinner\(/);
    expect(branch).toMatch(/goToLobbyWithResult\(1,/);
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
    const fn = tablePage.slice(at, at + 300);
    expect(fn).toMatch(/if \(exitStarted\) return;/);
    expect(fn).toMatch(/exitStarted = true;/);
  });

  it('the realtime event union still knows this event exists', () => {
    // Not the delivery path for the t-break channel, but it is the list the
    // next agent reads to learn what the engine emits. Letting it go stale is
    // how `broadcastWinner`/`broadcastElimination` became callerless.
    expect(realtime).toMatch(/'tournament_winner'/);
  });

  it("eliminatePlayer is still never called with place 1 — that is why this is needed", () => {
    // If this ever stops being true, the two paths can both fire and the
    // champion gets the card twice (or the elimination toast). The guard above
    // catches the double exit; this catches the cause.
    expect(engine).toMatch(/basePosition = Math\.max\(playingCount, bustedOrdered\.length \+ 1\)/);
    expect(engine).toMatch(/eliminatePlayer\(ordered\[i\]\.user_id, ordered\.length \+ 1 - i\)/);
  });
});
