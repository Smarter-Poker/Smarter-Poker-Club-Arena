/**
 * LAW: source maps are uploaded for the bundle that SHIPS, and never shipped.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. Three defects, one cause, all of them silent:
 *
 *  1. `sentryVitePlugin` activates only when
 *     `NODE_ENV === 'production' && SENTRY_AUTH_TOKEN`. SENTRY_AUTH_TOKEN was
 *     set on ci.yml's `Production Build` - a pull-request artifact that is
 *     measured and thrown away - and NOT on publish-club-arena.yml's build,
 *     the only bundle a player ever loads. Sentry held maps for code nobody
 *     runs and none for the code everybody runs, so every production stack
 *     trace came back minified.
 *
 *  2. `filesToDeleteAfterUpload` runs as part of that upload. Since the
 *     upload never ran on the publishing path, 267 `.map` files - 27MB - were
 *     rsync'd to the origin and served to players on every deploy.
 *
 *  3. The plugin tagged its release `club-arena@${npm_package_version}`
 *     (1.0.1) while `src/core/SentryInit.ts` tags every event
 *     `club-arena@${VITE_APP_VERSION}` (the publishing sha). Two different
 *     release names, so even a successful upload could not have symbolicated
 *     one event.
 *
 * None of the three would raise an alarm: the plugin's `errorHandler` warns
 * instead of failing, which is correct (a Sentry outage must not stop a
 * deploy) and is exactly why this has to be pinned by a test instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('source maps go to Sentry, not to players', () => {
  it('the publisher holds the upload token', () => {
    const publisher = read('.github/workflows/publish-club-arena.yml');
    expect(publisher).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
    expect(publisher).toContain('SENTRY_ORG: smarter-software-inc');
    expect(publisher).toContain('SENTRY_PROJECT: javascript-react');
  });

  it('the throwaway PR build does not, so nothing uploads maps for a discarded bundle', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/^\s*SENTRY_AUTH_TOKEN:/m);
  });

  it('the publisher strips every map unconditionally and refuses to ship a survivor', () => {
    const publisher = read('.github/workflows/publish-club-arena.yml');
    expect(publisher).toContain("find dist -name '*.map' -delete");
    // Unconditional and fatal: the plugin only deletes on a SUCCESSFUL upload,
    // so a Sentry outage must not become 27MB of source shipped to players.
    expect(publisher).toMatch(/source maps survived the strip/);
  });

  it('the verified policy release reaches the upload plugin and matches the runtime', () => {
    // The identity suite executes this policy and the actual Vite plugin factory
    // against real Git checkouts. These AST checks tie that exercised path to
    // the runtime expression without treating a comment as working wiring.
    const parse = (file: string) =>
      ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const nodes = (root: ts.Node): ts.Node[] => {
      const result: ts.Node[] = [];
      const visit = (node: ts.Node) => {
        result.push(node);
        ts.forEachChild(node, visit);
      };
      visit(root);
      return result;
    };
    const property = (object: ts.ObjectLiteralExpression, name: string) => {
      const result = object.properties.find(
        (node) => ts.isPropertyAssignment(node) && node.name.getText() === name
      );
      expect(result).toBeDefined();
      return (result as ts.PropertyAssignment).initializer;
    };
    const vite = nodes(parse('vite.config.ts'));
    const policy = nodes(parse('scripts/sentry-upload-policy.ts'));
    const runtime = nodes(parse('src/core/SentryInit.ts'));
    const resolution = vite.find(
      (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'sentryUpload'
    ) as ts.VariableDeclaration;
    expect(resolution.initializer?.getText()).toBe('resolveSentryUpload(process.env)');
    const plugin = vite.find(
      (node) => ts.isCallExpression(node) && node.expression.getText() === 'sentryVitePlugin'
    ) as ts.CallExpression;
    const release = property(plugin.arguments[0] as ts.ObjectLiteralExpression, 'release');
    expect(property(release as ts.ObjectLiteralExpression, 'name').getText()).toBe(
      'sentryUpload.release'
    );
    const version = policy.find(
      (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'version'
    ) as ts.VariableDeclaration;
    expect(version.initializer?.getText()).toBe('env.VITE_APP_VERSION');
    const enabledReturn = policy.find(
      (node) =>
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        ts.isObjectLiteralExpression(node.expression)
    ) as ts.ReturnStatement;
    expect(
      property(enabledReturn.expression as ts.ObjectLiteralExpression, 'release').getText()
    ).toBe("'club-arena@' + version");
    const init = runtime.find(
      (node) => ts.isCallExpression(node) && node.expression.getText() === 'Sentry.init'
    ) as ts.CallExpression;
    const runtimeRelease = property(init.arguments[0] as ts.ObjectLiteralExpression, 'release');
    expect(ts.isTemplateExpression(runtimeRelease)).toBe(true);
    const template = runtimeRelease as ts.TemplateExpression;
    expect(template.head.text).toBe('club-arena@');
    expect(template.templateSpans).toHaveLength(1);
    expect(template.templateSpans[0].expression.getText()).toBe(
      "import.meta.env.VITE_APP_VERSION || 'unknown'"
    );
    expect(template.templateSpans[0].literal.text).toBe('');
  });

  it('the additive pool is swept of maps too, or the old ones serve for 30 days', () => {
    const publisher = read('.github/workflows/publish-club-arena.yml');
    // /assets/* is served from a pool the publisher never --deletes, pruned by
    // AGE at 30 days. So stripping dist/ stops NEW maps reaching players and
    // does nothing about the ones already there - 267 files, 27MB, per deploy,
    // going back weeks. Deleting maps from the pool is safe in a way deleting
    // anything else from it is not: a player mid-hand asks for a hashed CHUNK,
    // never for its map, and a .map is fetched only by open devtools.
    expect(publisher).toMatch(/find pool -type f -name '\*\.map' -delete/);
  });

  it('the runtime reports a broken build as broken, not as version one', () => {
    // A build with no VITE_APP_VERSION has no maps uploaded for it and never
    // will. Reporting `club-arena@1.0.0` made that indistinguishable from a
    // real release in Sentry, so the one symptom of a misconfigured publish
    // looked like ordinary traffic.
    const init = read('src/core/SentryInit.ts');
    expect(init).toMatch(/VITE_APP_VERSION \|\| 'unknown'/);
    expect(init).not.toMatch(
      /release: `club-arena@\$\{import\.meta\.env\.VITE_APP_VERSION \|\| '1\.0\.0'\}`/
    );
  });

  it('the publisher sets VITE_APP_VERSION to the sha it is shipping', () => {
    const publisher = read('.github/workflows/publish-club-arena.yml');
    expect(publisher).toMatch(
      /VITE_APP_VERSION: \$\{\{ needs\.publish-needed\.outputs\.target_sha \}\}/
    );
  });
});
