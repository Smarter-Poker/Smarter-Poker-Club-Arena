import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The two retired union doors forward to `/unions`, and to nothing else.
 *
 * `tests/e2e/routes/phase7-doors.spec.ts` used to prove this against
 * production by reading the address bar after following `union-dashboard`.
 * It could not keep doing that honestly: `/unions` is closed by Dan's
 * 2026-09-05 ruling and `UnionNetworkGuard` forwards every refused account to
 * `/community`, so the certification account never rests on `/unions` and the
 * assertion was racing a network round trip. Measured in Post-Deploy E2E run
 * 35865600057: `union-games` passed on `/unions` at 13:37:05 and
 * `union-dashboard`, with the identical destination, failed on `/community`
 * in the same run.
 *
 * That spec now accepts either side of the guard. This is the half it can no
 * longer see, moved to where nothing can race it: the doors must hand off to
 * `/unions` and must not be quietly repointed at `/community`, which would
 * look identical from the browser and would silently retire a route Phase 7
 * deliberately kept.
 *
 * It reads App.tsx as text on purpose. Rendering the router would need the
 * whole provider tree, and the claim is about one routing declaration.
 */
const app = readFileSync(resolve(import.meta.dirname, '../../src/App.tsx'), 'utf8');

/** The `<Route ...>` element whose `path` is exactly `name`. */
function routeBlock(name: string): string {
  const anchor = `path="${name}"`;
  const at = app.indexOf(anchor);
  expect(at, `App.tsx declares no route with path="${name}"`).toBeGreaterThan(-1);
  expect(
    app.indexOf(anchor, at + anchor.length),
    `App.tsx declares path="${name}" more than once`
  ).toBe(-1);
  const opened = app.lastIndexOf('<Route', at);
  expect(opened).toBeGreaterThan(-1);
  // The element's own `/>` is inline; the Route's self-close sits alone on its
  // own line, so anchor on that rather than on the first `/>` after the path.
  const closed = app.slice(at).search(/\n\s*\/>/);
  expect(closed).toBeGreaterThan(-1);
  return app.slice(opened, at + closed);
}

describe('the Phase 7 union doors forward to /unions', () => {
  for (const door of ['union-dashboard', 'union-games']) {
    it(`${door} navigates to /unions and replaces its history entry`, () => {
      const block = routeBlock(door);
      expect(block, `${door} must hand off to /unions`).toMatch(
        /<Navigate\s+to="\/unions"\s+replace\s*\/>/
      );
    });

    it(`${door} does not skip /unions and its access rule`, () => {
      const block = routeBlock(door);
      const target = block.match(/<Navigate\s+to="([^"]+)"/)?.[1];
      expect(target, `${door} must name exactly one destination`).toBe('/unions');
    });

    it(`${door} still renders no page of its own`, () => {
      // The whole point of retiring it: the unparameterised twin guessed a
      // union for itself. Its `element` is the redirect and nothing else, so
      // read the prop rather than the block - the block carries the comment
      // that NAMES the retired page, which is documentation, not a render.
      const element = routeBlock(door)
        .match(/element=\{([\s\S]*)\}/)?.[1]
        ?.trim();
      expect(element, `${door} must declare one element`).toBeTruthy();
      expect(element).toMatch(/^<Navigate\s+to="\/unions"\s+replace\s*\/>$/);
    });
  }

  it('the parameterised pages the doors were retired in favour of still exist', () => {
    expect(app).toMatch(/path="unions\/:unionId\/games"/);
    expect(app).toMatch(/path="unions"/);
  });
});
