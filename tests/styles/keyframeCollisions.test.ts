/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  @keyframes IS A GLOBAL NAMESPACE — collisions are silent animation killers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 2026-08-21 animation parity audit counted 827 `@keyframes` across the
 * app's plain CSS files (CSS Modules scope theirs; plain .css does NOT). Two
 * files defining the same name with different bodies means last-loaded-wins:
 * an animation silently plays the WRONG motion depending on route load order,
 * with no error anywhere. The audit found zero genuine collisions — nine
 * `shimmer` definitions survive only because every one is byte-identical.
 *
 * This test makes that luck a law: a duplicate keyframe name across plain CSS
 * files must have an IDENTICAL body everywhere it appears, or this fails and
 * names the colliding files. Fix by prefixing the new animation (sw/trc/ko/
 * mbc-style component prefixes), never by editing the other file's copy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...cssFiles(p));
    // CSS Modules (*.module.css) scope their keyframes — skip them.
    else if (name.endsWith('.css') && !name.endsWith('.module.css')) out.push(p);
  }
  return out;
}

/** Extract { name -> body } for every @keyframes in one file. */
function extractKeyframes(css: string): Map<string, string> {
  const found = new Map<string, string>();
  const re = /@(?:-webkit-)?keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    // Walk to the matching close brace.
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css
      .slice(re.lastIndex, i - 1)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A file may legally re-declare its own name inside @media blocks
    // (e.g. reduced-motion variants use DIFFERENT names; same-name within
    // one file keeps the last body, matching the cascade).
    found.set(m[1], body);
  }
  return found;
}

describe('@keyframes global namespace', () => {
  it('no two plain CSS files define the same keyframe name differently', () => {
    const owners = new Map<string, { file: string; body: string }>();
    const collisions: string[] = [];
    for (const file of cssFiles(SRC)) {
      const rel = path.relative(SRC, file);
      for (const [name, body] of extractKeyframes(readFileSync(file, 'utf8'))) {
        const prev = owners.get(name);
        if (prev && prev.body !== body) {
          collisions.push(
            `@keyframes ${name}: ${prev.file} vs ${rel} — bodies differ. ` +
              'Prefix the newer animation with its component prefix.'
          );
        } else if (!prev) {
          owners.set(name, { file: rel, body });
        }
      }
    }
    expect(collisions, collisions.join('\n')).toEqual([]);
  });

  it('the audit baseline still holds: hundreds of keyframes were scanned', () => {
    let total = 0;
    for (const file of cssFiles(SRC)) {
      total += (readFileSync(file, 'utf8').match(/@keyframes\s+/g) || []).length;
    }
    // If this ever reads near-zero the glob broke and the guard above is
    // silently scanning nothing.
    expect(total).toBeGreaterThan(300);
  });
});
