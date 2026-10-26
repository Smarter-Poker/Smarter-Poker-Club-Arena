/**
 * A BUST THE DOOR PLACED IS NOT A FAILED BUST (2026-10-25).
 *
 * The knockout door (`fn_claim_tournament_bounty_elimination`) can record a
 * bust and deliberately write NO bounty obligation. It says so in the accepted
 * response as `bounty_blocked`. Since 2026-10-22 the commonest reason is
 * `mystery_bounties_start_in_the_money`: every bust before the money in a
 * chests-only mystery event (regular pool 0) is placed and pays nobody.
 *
 * `eliminatePlayer` skipped the bounty collection only for an UNATTRIBUTABLE
 * knocker. For every other `bounty_blocked` reason it went on to collect,
 * found no settled obligation (by design there is none), and returned false
 * for a bust that had already committed. The assignment pass reads false as a
 * refusal and ends, so each admission recorded ONE bust and then waited five
 * seconds for the next.
 *
 * Measured on production 2026-10-25, Sunday Funday PLO5 Mystery 0fed81b3 and
 * 11b1db64 (195 and 193 entrants, chests at the money): every admission was
 * exactly has-unsettled -> rebuy decisions -> one claim -> one collect, the two
 * events alternated one bust every 10-35 s, the backlog reached 24 pending
 * busts each and 24 minutes of lag, and fn_ca_absent_tournament_players raised
 * "Money Check Failed CRITICAL". No money moved wrongly; the busts were late.
 *
 * THE RULE: whenever the door's accepted answer carries `bounty_blocked`, the
 * bust is recorded and the engine never calls processBountyCollection for it,
 * so eliminatePlayer returns true and the batch keeps recording.
 *
 * docs/changelog/2026-10-25-a-bust-the-door-placed-is-not-a-failed-bust.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod } from './helpers/sourceWindow';

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const ELIMINATE = sliceMethod(SOURCE, 'protected async eliminatePlayer(');

describe('a bust the door placed is not a failed bust', () => {
  it('the no-obligation answer is remembered for the rest of eliminatePlayer', () => {
    expect(ELIMINATE).toContain('let doorWroteNoBountyObligation = false;');
    // set only inside the branch that read bounty_blocked off an ACCEPTED claim
    const branchStart = ELIMINATE.indexOf('if (bountyHeadNotAttributed) {');
    const branchEnd = ELIMINATE.indexOf('} else {', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(ELIMINATE.slice(branchStart, branchEnd)).toContain(
      'doorWroteNoBountyObligation = true;'
    );
  });

  it('collection is skipped for EVERY bounty_blocked reason, not only an unattributable knocker', () => {
    const collectAt = ELIMINATE.indexOf('await this.processBountyCollection(');
    expect(collectAt).toBeGreaterThan(-1);
    // exactly one collection call in eliminatePlayer, and it sits behind the
    // guard that refuses both kinds of no-obligation bust
    expect(ELIMINATE.indexOf('await this.processBountyCollection(', collectAt + 1)).toBe(-1);
    const guard =
      /if \(\s*bountyEvidence &&\s*bountyEvidence\.attributionUnavailable !== true &&\s*!doorWroteNoBountyObligation\s*\)\s*\{/.exec(
        ELIMINATE
      );
    expect(guard).not.toBeNull();
    expect(guard!.index).toBeLessThan(collectAt);
  });

  it('the flag is decided before the collection is reached', () => {
    const setAt = ELIMINATE.indexOf('doorWroteNoBountyObligation = true;');
    const collectAt = ELIMINATE.indexOf('await this.processBountyCollection(');
    expect(setAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(collectAt);
  });
});
