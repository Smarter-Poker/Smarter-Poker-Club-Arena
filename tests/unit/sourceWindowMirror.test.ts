/**
 * The server package cannot import the client's test helper (its tsconfig sets
 * `rootDir: ./src`), so `server/src/testHelpers/sourceWindow.ts` is a copy.
 * A copy nobody checks is a copy that drifts, and a drifted pin helper fails in
 * the silent direction - the server suite would keep asserting against windows
 * the client had already fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const body = (src: string) => src.slice(src.indexOf('*/') + 2).trim();

describe('the two copies of the source-window helper cannot drift', () => {
  it('server/src/testHelpers/sourceWindow.ts matches tests/helpers/sourceWindow.ts', () => {
    expect(body(read('server/src/testHelpers/sourceWindow.ts'))).toBe(
      body(read('tests/helpers/sourceWindow.ts'))
    );
  });
});
