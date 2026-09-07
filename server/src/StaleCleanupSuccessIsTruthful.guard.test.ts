/**
 * STARTUP CLEANUP MAY ONLY CLAIM SUCCESS AFTER ITS ORPHAN-TABLE WALK FINISHES.
 *
 * The orphan-table sweep keyset-pages the entire table estate. A failed page
 * read throws because a partial list cannot prove that cleanup is complete.
 * The failure is deliberately caught and reported so housekeeping cannot stop
 * the server boot, but the success log must remain inside the attempted sweep:
 * control that throws on a page read must never reach that claim.
 *
 * This is a source-order guard because cleanupStaleData is private and every
 * useful runtime path talks to Supabase. The property under test is the actual
 * control-flow boundary around the production query, not a mocked copy of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock, sliceMethod } from './testHelpers/sourceWindow.js';

const source = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
const cleanup = sliceMethod(source, 'private async cleanupStaleData(');
const orphanAttempt = sliceEnclosingBlock(cleanup, 'const orphanPageSize = 500');
const successClaim = "console.log('[GameServer] Stale data cleanup complete')";

describe('startup stale-cleanup success reporting', () => {
  it('does not call a failed stale-tournament list a completed sweep', () => {
    expect(cleanup).toMatch(
      /const \{ data: staleTourneys, error: staleTourneysError \} = await supabase[\s\S]*?if \(staleTourneysError\) \{[\s\S]*?GameServer\.stale_tournament_list_failed[\s\S]*?\}[\s\S]*?const staleTournamentCandidates = staleTourneysError \? \[\] : staleTourneys \|\| \[\][\s\S]*?if \(!staleTourneysError\) \{[\s\S]*?Stale-tournament sweep complete/
    );
  });

  it('keeps later COMPLETING and orphan cleanup reachable after a stale-list failure', () => {
    expect(cleanup).toMatch(
      /if \(!staleTourneysError\) \{[\s\S]*?Stale-tournament sweep complete[\s\S]*?\}\s*\/\/ 7\.[\s\S]*?recoverStuckCompletingTournaments\('startup-cleanup'\)[\s\S]*?const orphanPageSize = 500/
    );
  });

  it('does not disguise a failed RUNNING to COMPLETING claim as a benign CAS loss', () => {
    expect(cleanup).toMatch(
      /const \{ data: completingClaim, error: completingClaimError \} = await supabase[\s\S]*?if \(completingClaimError\) \{[\s\S]*?GameServer\.stale_tournament_claim_failed[\s\S]*?continue;[\s\S]*?if \(!completingClaim \|\| completingClaim\.length === 0\)/
    );
  });

  it('treats an orphan-table page-list error as a failed sweep', () => {
    expect(orphanAttempt).toMatch(
      /if \(openTableError\) \{[\s\S]*?throw new Error\(`orphan table list failed:/
    );
  });

  it('can reach the success claim only while the orphan-table attempt remains successful', () => {
    const pageFailure = orphanAttempt.indexOf('if (openTableError)');
    const claim = orphanAttempt.indexOf(successClaim);

    expect(pageFailure).toBeGreaterThan(-1);
    expect(claim, 'the success claim must stay inside the orphan-sweep try block').toBeGreaterThan(
      pageFailure
    );
    expect(cleanup.match(/Stale data cleanup complete/g)).toHaveLength(1);
  });
});
