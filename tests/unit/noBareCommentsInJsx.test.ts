/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A COMMENT BETWEEN TWO ELEMENTS IS TEXT, AND THE PLAYER READS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-23, with a screenshot of a live 1/2 table: under the felt, in
 * the page's own body text, "/* THE SIDE MENU IS GONE (2026-09-15). It could
 * not be opened: the only reference to `toggleSideMenu` was ..." - a whole
 * paragraph of an engineer's note, printed to every player at every table.
 *
 * JSX has no block comments. Between two elements, `/* ... *\/` is not a
 * comment, it is a JsxText node, and React renders a text node as text. The
 * note in TablePage.tsx was written as a bare comment when the old side menu
 * was removed (#4696), so its removal notice shipped in the removed menu's
 * place. The only comment form JSX children accept is `{/* ... *\/}`, an
 * expression container holding nothing.
 *
 * This walks every .tsx file under src with the TypeScript parser - the same
 * reading the compiler and the bundler do - and fails on any JsxText whose
 * text contains a comment opener. Not a regex over source: a `/*` inside a
 * string, an attribute or a real comment is not a text node, and the parser
 * knows which is which.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__snapshots__') continue;
      walk(full, out);
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Every JsxText node in `file` whose visible text opens a comment. */
export function bareCommentsInJsx(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf);
      if (/\/\*|^\s*\/\//m.test(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${relative(ROOT, file)}:${line + 1}: ${text.trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('no bare comment is rendered as text inside JSX', () => {
  it('the parser sees a comment opener in a JsxText node', () => {
    // The rule is a parser rule, so the test proves the detector on the exact
    // shape that shipped before it proves the tree is clean.
    const shipped = `const X = () => (<div>{a}\n  /* THE SIDE MENU IS GONE. */\n  <span/></div>);`;
    expect(bareCommentsInJsx('shipped.tsx', shipped)).toHaveLength(1);
    const fixed = `const X = () => (<div>{a}\n  {/* THE SIDE MENU IS GONE. */}\n  <span/></div>);`;
    expect(bareCommentsInJsx('fixed.tsx', fixed)).toHaveLength(0);
    // A URL in copy is not a comment.
    const url = `const X = () => (<p>See https://smarter.poker/help</p>);`;
    expect(bareCommentsInJsx('url.tsx', url)).toHaveLength(0);
  });

  it('every .tsx under src is clean', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) => bareCommentsInJsx(f, readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
