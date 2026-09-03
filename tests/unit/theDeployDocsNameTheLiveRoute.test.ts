/**
 * The documents an agent reads FIRST must not name a route that is gone.
 *
 * Club Arena stopped publishing through the World Hub on 2026-09-03. The
 * bundle is rsync'd to its own origin by publish-club-arena.yml and the World
 * Hub carries one rewrite. The scripts, the vendored directory and the Vercel
 * project are all deleted.
 *
 * Three documents did not get the message, and they are exactly the three an
 * agent opens before touching anything:
 *
 *   - deploy-paths.md carried an authoritative Tier 2 table saying "push a
 *     branch, nothing else" AND, ninety lines later, a decision tree saying
 *     "then `vercel --prod`". Same file, contradicting itself.
 *   - AGENTS-PUSH-GUIDE.md opened with a SUPERSEDED banner and then closed
 *     with a "Deploy pipeline note" describing the superseded pipeline in
 *     present tense.
 *   - .env.example said the three critical vars "MUST be set in Vercel
 *     dashboard", where setting them now changes nothing.
 *
 * A stale instruction is worse than a missing one: it is followed. This is a
 * text law, not a behaviour test, because the failure mode is a human or an
 * agent reading prose and doing what it says.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Repo root. vitest runs from it, and these paths are repo-relative by nature -
// they are the paths an agent is told to open.
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The docs an agent is pointed at before it publishes anything. */
const ROUTE_DOCS = [
  '.agent/architecture/deploy-paths.md',
  'AGENTS-PUSH-GUIDE.md',
  '.env.example',
] as const;

/**
 * Prose that TELLS you to do a dead thing. Deliberately not a bare search for
 * "vercel" or "World Hub": both legitimately appear in these files - Tier 3
 * really does deploy to Vercel from the World Hub repo, and the history of the
 * cutover is worth keeping. What must not survive is an instruction.
 */
const DEAD_INSTRUCTIONS: Array<[RegExp, string]> = [
  [/vercel\s+--prod/i, 'tells the reader to deploy this bundle with the Vercel CLI'],
  [
    /MUST be set in Vercel dashboard/i,
    'sends the reader to a Vercel dashboard that governs nothing',
  ],
  [/bash\s+scripts\/sync-club-arena\.sh/i, 'invokes a sync script deleted from main'],
  [/bash\s+scripts\/build-club-arena\.sh/i, 'invokes a build script deleted from main'],
  [/bash\s+scripts\/sync-to-world-hub\.sh/i, 'invokes a sync script deleted from main'],
];

describe('the deploy documents name the live route', () => {
  for (const path of ROUTE_DOCS) {
    it(`${path} gives no dead instruction`, () => {
      const text = read(path);
      for (const [pattern, why] of DEAD_INSTRUCTIONS) {
        expect(text, `${path} ${why}`).not.toMatch(pattern);
      }
    });
  }

  /**
   * The positive half. Removing the wrong route is only half the job - a
   * reader still has to be able to find the right one, and "push a branch" is
   * counter-intuitive enough that it has to be said out loud.
   */
  it('deploy-paths.md names the origin the bundle actually goes to', () => {
    const text = read('.agent/architecture/deploy-paths.md');
    expect(text).toContain('ca-static.smarter.poker');
    expect(text).toContain('publish-club-arena.yml');
  });

  it('AGENTS-PUSH-GUIDE.md describes publishing as the pipeline, not as a command', () => {
    const text = read('AGENTS-PUSH-GUIDE.md');
    expect(text).toContain('publish-club-arena.yml');
    expect(text).toContain('ca-static.smarter.poker');
    // The one instruction that IS still true.
    expect(text).toMatch(/push a branch/i);
  });

  /**
   * The build stamp is how anyone confirms a publish landed, and it is the
   * only check that distinguishes "merged" from "live". If the guide stops
   * mentioning it, the next outage gets debugged by guesswork.
   */
  it('AGENTS-PUSH-GUIDE.md says how to confirm a publish landed', () => {
    expect(read('AGENTS-PUSH-GUIDE.md')).toContain('build-info.json');
  });
});
