import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* A JSONB CONTAINMENT IS SENT AS JSON (2026-09-25).

   postgrest-js writes an ARRAY argument to `.contains()` as a Postgres array
   literal, `cs.{a,b}`. That is right for a text[] column and wrong for a jsonb
   one: an array of objects arrives as `{[object Object]}`, PostgREST answers
   22P02 "invalid input syntax for type json", and the read returns an error
   instead of rows. BUG 021 (HandHistoryService, 2026-04-16) fixed one caller
   and left three. The last one stopped every engine release at the legacy
   checkpoint (run 36081290135, proveBanksHeldNothing.dealtSinceRead,
   error=22P02). A jsonb containment passes JSON.stringify(...) instead, which
   postgrest-js sends verbatim. */

const root = resolve(__dirname, '../..');
const ROOTS = ['src', 'server/src', 'server/scripts', 'scripts'];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ARRAY_OF_OBJECTS = /\.contains\(\s*['"`][\w.]+['"`]\s*,\s*\[\s*\{/g;

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(name)) out.push(path);
  }
}

describe('a jsonb containment is sent as json', () => {
  it('no caller passes an array of objects to .contains()', () => {
    const files: string[] = [];
    for (const dir of ROOTS) walk(join(root, dir), files);
    expect(files.length).toBeGreaterThan(100);
    // Code only: a comment that names the trap (BUG 021) is not a caller.
    const code = (text: string) =>
      text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
    const offenders = files.flatMap((file) =>
      [...code(readFileSync(file, 'utf8')).matchAll(ARRAY_OF_OBJECTS)].map(
        (m) => `${relative(root, file)}: ${m[0]}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern it refuses is the one that broke', () => {
    expect(".contains('players', [{ userId: id }])".match(ARRAY_OF_OBJECTS)).not.toBeNull();
    expect(
      ".contains('players', JSON.stringify([{ userId: id }]))".match(ARRAY_OF_OBJECTS)
    ).toBeNull();
    expect(".contains('tags', ['a', 'b'])".match(ARRAY_OF_OBJECTS)).toBeNull();
  });
});
