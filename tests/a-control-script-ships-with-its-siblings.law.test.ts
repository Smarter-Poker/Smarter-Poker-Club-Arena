/**
 * LAW: a control script may only invoke a sibling its generation actually
 *      ships, and a sibling that is missing is UNKNOWN - never a verdict.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED (2026-09-21)
 * --------------------------
 * #5003 added `server/scripts/engine-release-inflight-hands.py` - the helper
 * that asks the DATABASE whether a hand is really in the air, so that a
 * preparation which can never resolve stops being mistaken for one. It was
 * correct, it was careful, and it answered three outcomes rather than two.
 *
 * It was never packaged. `install-engine-supervisor.sh` copies the control
 * plane into `/usr/local/lib/club-arena/engine-control-generations/<sha>/`
 * from a hand-maintained `REQUIRED_FILES` array, and the new file was not
 * added to it. The generation directory is also validated by EXACT SET
 * equality against that same array, so nothing else could have carried it in.
 *
 * The engine had then been frozen for 59 hours, and the release that would
 * have ended it printed, verbatim:
 *
 *     [engine-release-transaction] restart certificate is held shut only by
 *       {'f06_preparation_unresolved': 1}; consulting the database for hands
 *       actually in the air
 *     .../engine-release-inflight-hands.py: No such file or directory
 *     [engine-release-transaction] the database did not prove the felt is
 *       quiet; the cutover stays refused
 *
 * The last line is false. The database was never asked. The shell answered
 * 127 for a missing file, `if "$INFLIGHT_HANDS" ...; then` took any non-zero
 * as "not quiet", and five consecutive releases reported a database refusal
 * that had never happened - CLAUDE.md 10.86 rules 1 and 2, one level down
 * from the defect #5003 had just fixed one level up.
 *
 * WHAT THIS PINS
 * --------------
 * 1. Every sibling a control script invokes out of its own generation is in
 *    REQUIRED_FILES. Derived by scanning, not by listing: an enumeration is
 *    what failed, so this test refuses to add a second one to maintain.
 * 2. The two per-language syntax-check loops in the installer cover every
 *    file of that language in REQUIRED_FILES - the same drift, one line down.
 * 3. engine-release-inflight-hands.py by name, because that is the file that
 *    cost 59 hours.
 * 4. The gate keeps the helper's three outcomes distinct and still refuses on
 *    all of them. A missing or unrunnable helper says so IN ITS OWN WORDS and
 *    never claims the database refused.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '..', 'server', 'scripts');
const INSTALLER = join(SCRIPTS, 'install-engine-supervisor.sh');
const TRANSACTION = join(SCRIPTS, 'engine-release-transaction.sh');

const read = (path: string): string => readFileSync(path, 'utf8');

/** The one packaging manifest, parsed rather than restated. */
function requiredFiles(): string[] {
  const source = read(INSTALLER);
  const match = /\nREQUIRED_FILES=\(\n([\s\S]*?)\n\)\n/.exec(source);
  expect(match, 'install-engine-supervisor.sh must declare REQUIRED_FILES').toBeTruthy();
  const names = (match as RegExpExecArray)[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  expect(names.length).toBeGreaterThan(10);
  return names;
}

/**
 * Every generation-relative sibling any control script invokes.
 *
 * The installer materializes the generation from these variables, and every
 * script resolves its own siblings through one of them, so this is the whole
 * surface: a path built from any other root is not a packaged sibling.
 */
const GENERATION_ROOTS = [
  'CONTROL_DIR',
  'GENERATION_DIR',
  'GENERATION_STAGE',
  'SOURCE_DIR',
  'ENGINE_CONTROL_DIR',
];
const SIBLING = new RegExp(
  `\\$(?:\\{)?(?:${GENERATION_ROOTS.join('|')})(?:\\})?/([A-Za-z0-9._-]+\\.(?:sh|py|mjs|schema))`,
  'g'
);

function referencedSiblings(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const entry of readdirSync(SCRIPTS)) {
    if (!/\.(sh|py|mjs)$/.test(entry)) continue;
    const source = read(join(SCRIPTS, entry));
    for (const match of source.matchAll(SIBLING)) {
      const name = match[1];
      const callers = found.get(name) ?? [];
      if (!callers.includes(entry)) callers.push(entry);
      found.set(name, callers);
    }
  }
  return found;
}

describe('a control script ships with its siblings', () => {
  it('packages every sibling any control script invokes', () => {
    const packaged = new Set(requiredFiles());
    const missing: string[] = [];
    for (const [name, callers] of referencedSiblings()) {
      if (!packaged.has(name)) missing.push(`${name} (invoked by ${callers.join(', ')})`);
    }
    expect(
      missing,
      'These control scripts are invoked out of the installed generation but are ' +
        'absent from REQUIRED_FILES in install-engine-supervisor.sh, so the ' +
        'generation directory will not contain them and the caller will fail at ' +
        'run time with "No such file or directory" inside a break window:\n  ' +
        missing.join('\n  ')
    ).toEqual([]);
  });

  it('keeps every referenced sibling a file that actually exists in the repo', () => {
    const present = new Set(readdirSync(SCRIPTS));
    const absent = [...referencedSiblings().keys()].filter((name) => !present.has(name));
    expect(absent, `referenced control scripts that do not exist: ${absent.join(', ')}`).toEqual(
      []
    );
  });

  it('syntax-checks every packaged script of each language before activating it', () => {
    const source = read(INSTALLER);
    const packaged = requiredFiles();
    // Both per-language checks are `for script in ... done` blocks over a
    // second hand-written list of names. Read each whole block and decide
    // which language it checks from its body, never from its position.
    const blocks: string[] = [];
    for (let at = source.indexOf('for script in '); at >= 0; ) {
      const end = source.indexOf('done', at);
      expect(end, 'a for-script loop must be closed').toBeGreaterThan(at);
      blocks.push(source.slice(at, end));
      at = source.indexOf('for script in ', end);
    }
    expect(blocks.length, 'the installer must keep its two syntax-check loops').toBe(2);
    const pick = (needle: string): string => {
      const found = blocks.filter((block) => block.includes(needle));
      expect(found, `exactly one loop must run ${needle}`).toHaveLength(1);
      return found[0];
    };
    // The installer validates the staged generation before it becomes active.
    // A file that is packaged but checked by neither loop is installed unread.
    const bashLoop = pick('bash -n "$GENERATION_STAGE/$script"');
    const pythonLoop = pick('compile(open(__import__("sys").argv[1]');
    const unchecked = packaged.filter((name) => {
      if (name.endsWith('.sh')) return !bashLoop.includes(name);
      if (name.endsWith('.py')) return !pythonLoop.includes(name);
      return false;
    });
    expect(
      unchecked,
      `packaged but never syntax-checked before activation: ${unchecked.join(', ')}`
    ).toEqual([]);
  });

  it('packages the in-flight-hands helper by name', () => {
    // #5003 shipped this file and #5010-era releases could not run it. It is
    // the reason this law exists, so it is pinned by name as well as by scan.
    expect(requiredFiles()).toContain('engine-release-inflight-hands.py');
    expect(read(TRANSACTION)).toContain(
      'INFLIGHT_HANDS="$CONTROL_DIR/engine-release-inflight-hands.py"'
    );
  });

  it('keeps the helper three outcomes and never reports an absent file as a verdict', () => {
    const source = read(TRANSACTION);
    const at = source.indexOf('"$INFLIGHT_HANDS" --env-file "$ENV_FILE"');
    expect(at, 'the gate must still consult the helper').toBeGreaterThan(0);
    const branch = source.slice(at, source.indexOf('\n}', at));

    // Three defined answers, each named; 0 is the only one that proceeds.
    expect(branch).toMatch(/case "\$inflight_rc" in/);
    for (const code of ['0)', '1)', '3)']) expect(branch).toContain(code);
    expect(branch).toMatch(/126\|127\)/);
    expect(branch).toMatch(/\*\)/);

    // Exactly one `return 0`, inside the QUIET branch.
    expect(branch.match(/return 0/g) ?? []).toHaveLength(1);
    expect(branch.slice(branch.indexOf('0)'), branch.indexOf('1)'))).toContain('return 0');

    // A missing or unrunnable helper must say the database was not asked,
    // and must NOT claim the database refused (CLAUDE.md 10.86 rule 2).
    const absent = branch.slice(branch.indexOf('126|127)'), branch.indexOf('*)'));
    expect(absent).toContain('UNKNOWN');
    expect(absent).toContain('NEVER ASKED');
    expect(absent).not.toMatch(/did not prove the felt is quiet/);
    expect(branch.slice(branch.indexOf('*)'))).toContain('UNKNOWN');

    // No flag, variable or argument may turn any refusal into permission.
    expect(branch).not.toMatch(/SKIP|FORCE|OVERRIDE|ALLOW_/);
  });
});
