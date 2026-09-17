/**
 * LAW: a doc may not assert something about this environment that stopped
 * being true, with nothing checking.
 * ═══════════════════════════════════════════════════════════════════════════
 * Created 2026-09-12. On that day three separate agents were handed diagnoses
 * that were wrong, and one nearly shipped two regressions, because the
 * instructions they were reading described a machine that no longer existed.
 * Five instances, all found in one night, all the same shape:
 *
 *   1. `CLAUDE.md` 10.83 and `AGENT-PLAYBOOK` 1 both said "`gh` is not
 *      installed". It is: /opt/homebrew/bin/gh, v2.86.0, authenticated as
 *      Smarter-Poker. The real problem was never installation - `gh` is
 *      absent from the NON-INTERACTIVE PATH, which is a different fact with a
 *      different fix, and the docs sent everyone to the wrong one.
 *   2. `CLAUDE.md` 10.82 documented an `AGENT_MERGED_BRANCH_OK=1` bypass for
 *      `scripts/guard-merged-branch.sh`. The script had been rewritten to
 *      have no bypass at all. A guard whose documented escape hatch does not
 *      exist is worse than an undocumented guard: the agent spends its time
 *      on the hatch.
 *   3. `AGENTS-PUSH-GUIDE.md` said every token on the Mac was dead. One was
 *      not, and the guide told agents not to go looking for it.
 *   4. `.claude/skills/deploy-hetzner/SKILL.md` on disk named VPS
 *      178.156.160.206 as the engine. That is `club-arena-turn`, the TURN
 *      server; the engine is 5.161.252.33. `origin/main` had carried the
 *      corrected v2.0.0 for days - but an agent LOADS the copy on disk.
 *   5. `CLAUDE.md` referenced `.github/scripts/engine-watchdog.sh` and
 *      `.github/scripts/deploy-ship-rate.mjs`, both deleted in #4189.
 *
 * Item 4 is a staleness problem and belongs to
 * `scripts/check-checkout-freshness.sh`, which measures the distance between
 * what is on disk and what is on `origin/main`. Item 3 is a claim about a
 * credential and cannot be tested without reading one, which this repo
 * forbids. The other three are checkable from the tree alone, and this law
 * checks exactly those three and nothing else:
 *
 *   - a script a binding doc NAMES must exist;
 *   - an override a binding doc or a guard's own header DOCUMENTS must be
 *     read by the thing that implements it;
 *   - a tool a binding doc calls ABSENT must not be one this repo's own
 *     guards require.
 *
 * It is deliberately narrow. The point is not to validate prose; it is that
 * the three specific assertions a doc makes about THIS MACHINE - a path, an
 * environment variable, a binary - are the three that silently rot, and each
 * one is mechanically checkable.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The documents an agent is told to obey before it touches anything. */
const BINDING_DOCS = ['CLAUDE.md', 'AGENT-PLAYBOOK.md', 'AGENTS-PUSH-GUIDE.md'];

/**
 * A doc is allowed to talk ABOUT something that is gone - most of this repo's
 * doctrine is a record of what was retired and why, and that history is the
 * reason the rules are followed. What it may not do is name a script as a
 * thing you can run when there is nothing there to run. These words in the
 * surrounding lines mark the difference.
 */
const NOTES_ABSENCE =
  /delet|remov|retire|gone\b|no longer|absent|dead\b|must not exist|never exist|used to|former|does not exist|was restored|not installed|stale/i;

/** Another repository's script is that repository's problem, not this one's. */
const NAMES_ANOTHER_REPO = /World Hub|Smarter-Poker-World-Hub|world-hub/i;

const SCRIPT_REF =
  /(?:\.github\/scripts|scripts|server\/scripts)\/[A-Za-z0-9._/-]+\.(?:sh|mjs|cjs|js|ts)(?![A-Za-z0-9])/g;

function contextAround(lines: string[], i: number): string {
  return lines.slice(Math.max(0, i - 3), i + 4).join('\n');
}

describe('the docs describe THIS environment', () => {
  it('every script a binding doc names is a script that exists', () => {
    const broken: string[] = [];
    for (const doc of BINDING_DOCS) {
      const lines = read(doc).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(SCRIPT_REF)) {
          const path = m[0];
          if (existsSync(join(ROOT, path))) continue;
          const ctx = contextAround(lines, i);
          // Naming its absence, or naming another repo, is not a false claim.
          if (NOTES_ABSENCE.test(ctx) || NAMES_ANOTHER_REPO.test(ctx)) continue;
          broken.push(`${doc}:${i + 1} names ${path}, which does not exist`);
        }
      });
    }
    expect(
      broken,
      'A binding doc points an agent at a script that is not here. Either the ' +
        'script was deleted and the reference must go with it (CLAUDE.md ' +
        'carried `.github/scripts/engine-watchdog.sh` for days after #4189 ' +
        'deleted it), or the deletion was a regression and the script must ' +
        'come back. Saying so in the text - "deleted", "retired", "no longer" - ' +
        'is always allowed; naming it as runnable is not.'
    ).toEqual([]);
  });

  /**
   * An override is a promise: "when this guard is wrong about you, here is the
   * way out". CLAUDE.md 10.82 kept that promise for `AGENT_MERGED_BRANCH_OK=1`
   * after the guard stopped honouring it, and an agent blocked by the guard
   * spent its time on a variable nothing reads.
   */
  it('every override a doc or a guard header documents is actually read', () => {
    /**
     * An override counts when the text tells you to RUN it: `VAR=1 git push`.
     * Naming the variable is not the same thing, and the difference matters
     * here more than usual, because correcting one of these means writing a
     * paragraph that says the variable is gone - and the first version of this
     * test flagged those paragraphs, including the ones in this very commit.
     * `VAR=1` followed by a command is the shape of the promise; `VAR=1`
     * followed by a backtick or a comma is prose about it.
     */
    const OVERRIDE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})=1\s+[a-z]/g;
    const MEANS_OVERRIDE = /bypass|override|escape hatch|opt out|skip|refus|allow/i;

    const sources: Array<{ name: string; body: string }> = BINDING_DOCS.map((d) => ({
      name: d,
      body: read(d),
    }));
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (!f.endsWith('.sh')) continue;
      sources.push({ name: `scripts/${f}`, body: read(`scripts/${f}`) });
    }

    // Everything that could plausibly honour an override.
    const implementations: string[] = [];
    const collect = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) collect(rel);
        else if (statSync(join(ROOT, rel)).size < 1_000_000) implementations.push(read(rel));
      }
    };
    collect('scripts');
    collect('.husky');
    collect('.github');

    const unkept: string[] = [];
    for (const { name, body } of sources) {
      const lines = body.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(OVERRIDE)) {
          const varName = m[1];
          if (!MEANS_OVERRIDE.test(contextAround(lines, i))) continue;
          // NAMING the variable is not READING it. The first version of this
          // test counted any occurrence, and a sentence in
          // `check-checkout-freshness.sh`'s header explaining the 2026-09-12
          // incident - which mentions AGENT_MERGED_BRANCH_OK to say it is gone -
          // was enough to convince it the bypass still existed. That is the
          // same "confident answer it had no business giving" as 10.86. So
          // require the shape of an actual read.
          const isRead = new RegExp(
            `\\$\\{?${varName}\\b|process\\.env\\.${varName}\\b|` +
              `process\\.env\\[['"\`]${varName}['"\`]\\]`
          );
          if (implementations.some((src) => isRead.test(src))) continue;
          unkept.push(`${name}:${i + 1} documents ${varName}=1, which nothing reads`);
        }
      });
    }
    expect(
      unkept,
      'A documented escape hatch that does not exist is worse than no ' +
        'documentation: the agent it was written for spends its time on the ' +
        'hatch instead of on the refusal. Either implement it, or delete the ' +
        'sentence in the same commit that removed it.'
    ).toEqual([]);
  });

  /**
   * The `gh` claim cost the most, because it was not simply out of date - it
   * was the RIGHT OBSERVATION with the WRONG CAUSE. `gh` really is unusable
   * from a non-interactive shell, so every agent that hit it agreed with the
   * doc and stopped looking. The cause is PATH, and the fix is one line.
   */
  it('no binding doc calls a tool absent when this repo’s own guards require it', () => {
    // Tools the pre-push guards will not run without.
    const hook = read('.husky/pre-push');
    // Only guards the hook actually RUNS. Matching every `scripts/*.sh` the
    // file MENTIONS picks up the ones named in its comments (agent-workspace.sh
    // among them) and demands PATH repair for tools no push ever needs.
    const guards = [...hook.matchAll(/bash\s+[^\n]*?scripts\/([A-Za-z0-9._-]+\.sh)/g)].map(
      (m) => m[1]
    );
    const required = new Set<string>();
    for (const g of ['pre-push', ...guards]) {
      const body =
        g === 'pre-push' ? hook : existsSync(join(ROOT, 'scripts', g)) ? read(`scripts/${g}`) : '';
      for (const m of body.matchAll(/command -v ["']?([a-z0-9_-]+)["']?/g)) required.add(m[1]);
    }
    expect(required.has('gh'), 'guard-merged-branch.sh should still require gh').toBe(true);

    // This matches the CANONICAL phrasings, not every possible sentence: it is
    // a tripwire on the claim that actually recurs, not a prose validator. It
    // also cannot tell an assertion from a QUOTATION of a retired one, so when
    // you correct a claim here, describe what the old text said rather than
    // reprinting it word for word.
    const lies: string[] = [];
    for (const doc of BINDING_DOCS) {
      const body = read(doc);
      for (const tool of required) {
        const claim = new RegExp(
          '`?\\b' +
            tool +
            '\\b`?[^\\n]{0,60}?(?:is not installed|isn’t installed|' +
            "isn't installed|is not available|cannot be installed|not installed (?:here|there|on))",
          'i'
        );
        const m = body.match(claim);
        if (m)
          lies.push(`${doc} says: "${m[0].trim()}" - but a guard in this repo requires ${tool}`);
      }
    }
    expect(
      lies,
      'A guard that fails closed on a missing tool and a doc that says the ' +
        'tool is missing cannot both be right. On 2026-09-12 both were in the ' +
        'tree: scripts/guard-merged-branch.sh refuses every push without `gh`, ' +
        'while CLAUDE.md and AGENT-PLAYBOOK said `gh` was not installed. It ' +
        'was installed; it was not on the non-interactive PATH.'
    ).toEqual([]);
  });

  /**
   * And the fix itself has to stay. `.husky/pre-push` already repaired PATH
   * for `node`, after a missing node was reported to an agent as "page copy is
   * not Title Cased". The identical failure then happened to `gh`, because
   * the repair named one tool instead of the set the guards need.
   */
  /**
   * The check that measures whether the docs on disk are current must not be
   * able to lie about it. Git exports GIT_DIR to its hooks, and `git -C <dir>`
   * does NOT override it, so the first real pre-push run of
   * check-checkout-freshness.sh answered with the PUSHING repo's identity for
   * every directory it looked at and announced 25 clones of Club Arena,
   * Smarter-Poker-Arcade among them. A freshness check that measures the wrong
   * repository is the defect in this file's title wearing a different hat.
   */
  it('the freshness check clears the git environment a hook hands it', () => {
    const src = read('scripts/check-checkout-freshness.sh');
    const unset = src.match(/^unset GIT_DIR[\s\S]*?$/m);
    expect(unset, 'check-checkout-freshness.sh must unset the inherited git env').not.toBeNull();
    const block = src.slice(src.indexOf('unset GIT_DIR'), src.indexOf('QUIET=0'));
    for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
      expect(block, `${v} must be cleared before any \`git -C\` call`).toContain(v);
    }
  });

  it('the pre-push hook puts every tool its guards require on PATH', () => {
    const hook = read('.husky/pre-push');
    // Only guards the hook actually RUNS. Matching every `scripts/*.sh` the
    // file MENTIONS picks up the ones named in its comments (agent-workspace.sh
    // among them) and demands PATH repair for tools no push ever needs.
    const guards = [...hook.matchAll(/bash\s+[^\n]*?scripts\/([A-Za-z0-9._-]+\.sh)/g)].map(
      (m) => m[1]
    );
    const required = new Set<string>();
    for (const g of ['pre-push', ...guards]) {
      const body =
        g === 'pre-push' ? hook : existsSync(join(ROOT, 'scripts', g)) ? read(`scripts/${g}`) : '';
      for (const m of body.matchAll(/command -v ["']?([a-z0-9_-]+)["']?/g)) required.add(m[1]);
    }
    // The repair block declares its tools in one list, so this test reads the
    // list rather than guessing which lines are the repair.
    const repaired = hook.match(/for TOOL in ([a-z0-9 _-]+); do/);
    expect(repaired, '.husky/pre-push has no `for TOOL in ...` PATH repair block').not.toBeNull();
    const covered = new Set(repaired![1].trim().split(/\s+/));
    const missing = [...required].filter((t) => !covered.has(t));
    expect(
      missing,
      'A guard requires a tool the hook does not make resolvable. On this Mac ' +
        '/opt/homebrew/bin is NOT on a non-interactive PATH, so the tool is ' +
        'present, `command -v` says no, and the guard fails closed on a push ' +
        'that was never wrong. Add the tool to the `for TOOL in ...` list.'
    ).toEqual([]);
    expect(hook, 'the repair must name the directory the tools actually live in').toContain(
      '/opt/homebrew/bin'
    );
  });
});

const POLICY_FILES = ['OWNER-POLICY.md', 'OPERATING-LAW.md', 'HARDENING.md', 'REFERENCE-INDEX.md'];
const FIRST_OPEN_DOCS = [
  'AGENT-PLAYBOOK.md',
  'AGENTS-PUSH-GUIDE.md',
  'CLAUDE.md',
  '.agents/rules/00-agent-playbook.md',
];
const RETIRED_ACTIVE_DIRECTIONS = [
  /your job ends at [“"`]push a branch/i,
  /autopilot (?:squash-)?merges (?:it |only |the moment)/i,
  /gh[^\n]{0,20}is NOT installed/i,
  /migrations[^\n]*will be applied by CI/i,
  /root retains sole (?:integration|release)/i,
];

describe('active agent instructions use the current policy', () => {
  it('the root loader reaches the portable policy and every policy file exists', () => {
    const loader = read('AGENTS.md');
    for (const file of POLICY_FILES) {
      expect(loader).toContain(`docs/agent-policy/${file}`);
      expect(read(`docs/agent-policy/${file}`).trim().length).toBeGreaterThan(0);
    }
  });

  it('first-open guides do not reinstate retired release or environment directions', () => {
    for (const file of FIRST_OPEN_DOCS) {
      for (const retired of RETIRED_ACTIVE_DIRECTIONS) {
        expect(read(file), `${file} reinstates ${retired}`).not.toMatch(retired);
      }
    }
  });
});
