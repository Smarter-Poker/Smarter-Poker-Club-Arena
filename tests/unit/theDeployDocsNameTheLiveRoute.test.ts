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
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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
/**
 * WIDENED 2026-09-04, because this list caught none of what was actually out
 * there. Requiring a literal `bash ` prefix let two whole shapes through:
 *
 *   - an ABSOLUTE path -
 *     `bash ~/Documents/Smarter-Poker-World-Hub/scripts/build-club-arena.sh`
 *     (`.agent/workflows/club-arena-rebuild.md:23` in the World Hub);
 *   - prose - "Deploy via `scripts/sync-club-arena.sh`"
 *     (`docs/STATS-PAGE-BUILDOUT-PLAN-2026-08-21.md:1096` here).
 *
 * Both were live instructions. Matching the script PATH catches every way an
 * instruction can be written, and the retirement-word exemption below is what
 * keeps a correction from tripping the law it is correcting.
 */
const DEAD_INSTRUCTIONS: Array<[RegExp, string]> = [
  [/vercel\s+--prod/i, 'tells the reader to deploy this bundle with the Vercel CLI'],
  [
    /MUST be set in Vercel dashboard/i,
    'sends the reader to a Vercel dashboard that governs nothing',
  ],
  [/scripts\/sync-club-arena\.sh/i, 'names a sync script deleted from main'],
  [/scripts\/build-club-arena\.sh/i, 'names a build script deleted from main'],
  [/scripts\/sync-to-world-hub\.sh/i, 'names a sync script deleted from main'],
  [/build-for-world-hub/i, 'names the publisher by a name it lost on 2026-09-03'],
];

/**
 * A mention is allowed when the text right beside it says the thing is gone or
 * forbidden. Corrections have to be able to name what they correct.
 *
 * ONE LINE EITHER SIDE, DELIBERATELY. A wider window lets an unrelated
 * "FORBIDDEN" elsewhere in the same paragraph excuse a live instruction - that
 * happened in the World Hub's copy of this law with
 * `.agent/workflows/completion-protocol.md`. A prohibition that actually
 * governs a line is written next to it.
 */
const RETIREMENT_WORDS =
  /\b(deleted|retired|gone|no longer|does not exist|REPLACED|REWRITTEN|CORRECTED|corrected|rewritten|used to|was\b|forbidden|forbids|must not|never|until)\b/i;

/**
 * Records of what HAPPENED, not instructions for what to do. MIGRATION-CHANGELOG
 * is frozen history by decree (CLAUDE.md section 10 rule 9), a dated handoff is
 * an account of what its author was told, and a changelog entry has to be able
 * to name the thing it retired. Sanitising those would destroy the only record
 * of why these rules exist, and nobody opens a dated file looking for today's
 * deploy command. The line between a record and an instruction is the path.
 */
const HISTORY_PATHS = [
  'docs/_archive/',
  'docs/changelog/',
  'docs/handoffs/',
  'docs/HANDOFF-',
  '.agent/audits/',
  '.agent/handoffs/',
  '.memory/decisions/',
  'MIGRATION-CHANGELOG.md',
  'MASTER-MIGRATION-DOCUMENT.md',
];

/** A file whose NAME starts with a date is a dated record, wherever it lives. */
const DATED = /(^|\/)\d{4}-\d{2}-\d{2}[-.]/;

/** Every doc and script an agent in this repo might read or run. */
function docsAndScripts(root: string): string[] {
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    'public',
    '.agent-trees',
    '_to_delete',
    'playwright-report',
    'test-results',
    'e2e-live',
    '.venv',
  ]);
  const out: string[] = [];
  const walk = (dir: string) => {
    // withFileTypes, and SYMLINKS ARE SKIPPED. A CI runner's checkout carries
    // a dangling `.node_modules` symlink (agents link the shared install in
    // rather than reinstalling), and `statSync` on a dangling link throws
    // ENOENT - which failed this whole law on the runner while passing on
    // every machine where the target existed. A symlink is never a document
    // this repo is responsible for anyway.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(md|sh)$/.test(entry.name)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

function deadInstructionsIn(text: string): string[] {
  const found: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, why] of DEAD_INSTRUCTIONS) {
      if (!pattern.test(lines[i])) continue;
      const context = lines.slice(Math.max(0, i - 1), i + 2).join('\n');
      if (RETIREMENT_WORDS.test(context)) continue;
      // The whole line, untruncated. A `.slice(0, N)` here is a magic
      // number in a test file, and noFixedSizeSourceWindows refuses one on
      // sight - correctly, since it cannot tell a display truncation from a
      // source window that will silently drift off the code it guards. A
      // markdown or shell line is short enough to print in full anyway.
      found.push(`line ${i + 1}: ${why} -> ${lines[i].trim()}`);
    }
  }
  return found;
}

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

  /**
   * THE SWEEP. The three files above were the three that were NOTICED. Sweeping
   * the repo on 2026-09-04 found four more that an agent reads first and that
   * still described the retired route in the present tense - among them
   * `docs/HANDOFF_CURRENT_STATE.md`, which CLAUDE.md line 3 sends every
   * engine-restart agent to before anything else, and
   * `.memory/context/001-architecture.md`, whose "DEPLOYMENT PIPELINE" was four
   * numbered steps ending in "Push World Hub to GitHub".
   *
   * A hand-written list of three only ever guards the three somebody
   * remembered.
   */
  it('no markdown or shell file in this repo gives a dead deploy instruction', () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const path of docsAndScripts(root)) {
      if (path === 'tests/unit/theDeployDocsNameTheLiveRoute.test.ts') continue;
      if (HISTORY_PATHS.some((h) => path.startsWith(h))) continue;
      if (DATED.test(path)) continue;
      const found = deadInstructionsIn(read(path));
      if (found.length) offenders.push(`${path}\n    ${found.join('\n    ')}`);
    }
    expect(
      offenders,
      'these files tell an agent to publish through the World Hub. Next.js serves ' +
        'public/ BEFORE the rewrite, so following them SHADOWS the live bundle ' +
        'rather than duplicating it - production freezes on the committed copy ' +
        'while the publisher publishes where nobody reads:\n  ' +
        offenders.join('\n  ')
    ).toHaveLength(0);
  });
});
