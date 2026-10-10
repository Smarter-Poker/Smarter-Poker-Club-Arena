// Execute the maintained visit body, rather than reproducing its implementation.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const spec = readFileSync('tests/e2e/production-csp-violations.spec.ts', 'utf8');
const source = readFileSync('tests/e2e/support/cspRouteObservation.ts', 'utf8');
function visitBody(text: string) {
  const tree = ts.createSourceFile('csp.ts', text, ts.ScriptTarget.Latest, true);
  let body = '';
  function find(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(tree) === 'visitCspRoute')
      body = node.getText(tree).replace('export ', '');
    ts.forEachChild(node, find);
  }
  find(tree);
  if (!body) throw new Error('Missing maintained CSP visit');
  return ts.transpileModule(`${body}; const visit = visitCspRoute;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function harness(text = source, failure?: 'scroll' | 'collector' | 'http' | 'empty') {
  const found: unknown[] = [];
  const navigation: string[] = [];
  const windows: number[] = [];
  let violations: unknown[] = [];
  const page = {
    async goto(_url: string, options: { waitUntil: string }) {
      navigation.push(options.waitUntil);
      // The first document sees a violation. A fallback reload loses it.
      violations = navigation.length === 1 ? [{ directive: 'img-src', blockedURI: 'fixture' }] : [];
      if (options.waitUntil === 'networkidle')
        throw new Error('Persistent request never becomes idle');
      return {
        ok: () => failure !== 'http',
        status: () => 503,
        headers: () => ({ 'content-type': 'text/html' }),
      };
    },
    locator: (selector: string) => ({
      selector,
      async waitFor() {},
      async innerText() {
        return 'Rendered app';
      },
    }),
    async waitForFunction() {
      if (failure === 'empty') throw new Error('application has no content');
    },
    async waitForTimeout(ms: number) {
      windows.push(ms);
    },
    async evaluate(fn: () => unknown) {
      const observedWindow = {
        __cspViolations: failure === 'collector' ? undefined : violations,
        scrollTo() {
          if (failure === 'scroll') throw new Error('scroll failed');
        },
      };
      // Execute the actual collection/scroll callback, including its missing-array refusal.
      return new Function('window', 'document', `return (${fn.toString()})();`)(observedWindow, {
        body: { scrollHeight: 1000 },
      });
    },
  };
  const assertion = (value: unknown) => ({
    not: { toBeNull: () => expect(value).not.toBeNull(), async toContainText() {} },
    toBe: (expected: unknown) => expect(value).toBe(expected),
    toContain: (expected: string) => expect(value).toContain(expected),
    async toBeVisible() {},
    async toContainText() {
      if (failure === 'empty') throw new Error('application has no content');
    },
  });
  const visit = new Function('page', 'expect', 'found', `${visitBody(text)}; return visit;`)(
    page,
    assertion,
    found
  );
  return {
    async run() {
      const batch = await visit(page, 'http://fixture/club-arena/', 'arena:/');
      for (const v of batch) found.push({ ...v, route: 'arena:/' });
    },
    found,
    navigation,
    windows,
  };
}

describe('CSP observation owns one rendered document', () => {
  it('retains first-document violations despite a persistent request', async () => {
    const h = harness();
    await h.run();
    expect(h.navigation).toEqual(['domcontentloaded']);
    expect(h.windows).toEqual([3500, 2000]);
    expect(h.found).toEqual([{ directive: 'img-src', blockedURI: 'fixture', route: 'arena:/' }]);
  });
  it('demonstrates the old network-idle fallback losing the original evidence', async () => {
    const old = source.replace(
      /const response = await page.goto[\s\S]*?(?=await page.waitForTimeout\(3500\))/,
      `try { await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); }
      catch { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
      const selector = '#root';
      `
    );
    const h = harness(old);
    await h.run();
    expect(h.navigation).toEqual(['networkidle', 'domcontentloaded']);
    expect(h.found).toEqual([]);
  });
  it.each(['scroll', 'collector', 'http', 'empty'] as const)(
    'refuses %s failure as zero violations',
    async (failure) => {
      const h = harness(source, failure);
      await expect(h.run()).rejects.toThrow();
    }
  );
  it('keeps all eight routes, the original observation windows, and zero-violation assertion', () => {
    expect(spec).toContain("['', 'clubs', 'wallet', 'profile', 'promotions']");
    expect(spec).toContain("['/', '/hub/diamond-store', '/hub/trivia']");
    expect(spec).toContain('test.setTimeout(240_000)');
    expect(spec).toContain(').toEqual([])');
    expect(spec).toContain('visitCspRoute(page, url, label)');
    expect(source).toContain('CSP collector is unavailable');
  });
});
