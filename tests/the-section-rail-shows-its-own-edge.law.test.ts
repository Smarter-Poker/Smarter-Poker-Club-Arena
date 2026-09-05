/**
 * THE SECTION RAIL SHOWS THE EDGE IT DRAWS, AND THE UNION DIRECTORY IS ASKED FOR.
 *
 * Two things Dan reported on 2026-09-05, pinned together because they live in
 * the same navigation surface.
 *
 * 1. "FIX THE BROKEN HEADERS". Both rails set `overflow: hidden` and had
 *    `padding-bottom: 0`, which put the chassis's bottom edge exactly on the
 *    rail's clipping boundary - measured on production, chassis bottom and rail
 *    bottom were the same y to the pixel. The bottom border, the two 8px
 *    clip-path corner bevels, the `0 8px 24px` drop shadow and the blue
 *    `::after` underline were all cut away, leaving a three-sided box.
 *
 * 2. "(AND THIS PAGE SHOULD BE HIDDEN TO EVERYONE EXECPT ME: .../unions)".
 *    Removing a link is not hiding a page and hiding a page is not removing the
 *    link; both have to hold, and both have to read the same server answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const RAILS = [
  'src/components/navigation/ArenaSectionRail.module.css',
  'src/components/navigation/ClubOperationsRail.module.css',
];

describe('the rail reserves room for the edge it draws', () => {
  for (const sheet of RAILS) {
    it(`${sheet} never clips its chassis against a zero bottom padding`, () => {
      const css = read(sheet);

      // Every `.rail` padding declaration, top-level and inside media queries.
      const paddings = [...css.matchAll(/\.rail\s*\{([\s\S]*?)\}/g)]
        .map((match) => /padding:\s*([^;]+);/.exec(match[1])?.[1]?.trim())
        .filter((value): value is string => Boolean(value));

      expect(paddings.length).toBeGreaterThan(0);
      for (const padding of paddings) {
        // Split on top-level whitespace only: `clamp(10px, 2vw, 24px)` is ONE
        // component and a naive split would read it as three.
        const parts: string[] = [];
        let depth = 0;
        let current = '';
        for (const char of padding) {
          if (char === '(') depth += 1;
          if (char === ')') depth -= 1;
          if (/\s/.test(char) && depth === 0) {
            if (current) parts.push(current);
            current = '';
          } else {
            current += char;
          }
        }
        if (current) parts.push(current);

        // 1 value: all sides. 2 values: `vertical horizontal`, so bottom equals
        // top and the chassis is safe by construction. 3 or 4 values name a
        // bottom of their own, and the shipped bug was a literal `0` there.
        const bottom = parts.length >= 3 ? parts[2] : parts[0];
        expect(bottom, `"padding: ${padding}" leaves no room below the chassis`).not.toMatch(
          /^0(px|rem|em|%)?$/
        );
      }

      // The clipping and the thing being clipped both still exist, so this
      // test keeps meaning something.
      expect(css).toMatch(/\.rail\s*\{[\s\S]*?overflow:\s*hidden/);
      expect(css).toMatch(/\.chassis\s*\{[\s\S]*?clip-path:\s*polygon/);
    });
  }
});

describe('the union directory is offered only where the server says yes', () => {
  it('routes /unions through the guard', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/path="unions"[\s\S]{0,240}<UnionNetworkGuard>/);
  });

  it('asks the database, and fails closed', () => {
    const hook = read('src/hooks/useCanOperateUnionNetwork.ts');
    expect(hook).toContain('fn_can_i_operate_the_union_network');
    // No argument: the answer is about auth.uid(), so a browser cannot ask
    // about another account.
    expect(hook).toMatch(/rpc\('fn_can_i_operate_the_union_network'\)/);
    expect(hook).toContain('allowed: false, checking: false');

    const guard = read('src/components/auth/UnionNetworkGuard.tsx');
    expect(guard).toContain('useCanOperateUnionNetwork');
    expect(guard).toMatch(/if \(!canOperateUnionNetwork\) return <Navigate/);
    // Not back to /unions - that would be a redirect loop.
    expect(guard).not.toMatch(/Navigate to="\/unions"/);
  });

  it('never lists a union destination the account cannot open', () => {
    const nav = read('src/config/arenaSectionNavigation.ts');
    // The community rail must not carry a hardcoded Unions entry any more.
    const communityArray = /const COMMUNITY_ITEMS:[^=]*=\s*\[([\s\S]*?)\];/.exec(nav)?.[1];
    expect(communityArray, 'COMMUNITY_ITEMS not found').toBeTruthy();
    expect(communityArray).not.toContain("'/unions'");
    // Every union destination in the rail is behind the same flag.
    const unionEntries = [
      ...nav.matchAll(/\{ label: '(?:Unions|Directory)', path: '\/unions' \}/g),
    ];
    expect(unionEntries.length).toBeGreaterThan(0);
    for (const entry of unionEntries) {
      const before = nav.slice(Math.max(0, entry.index! - 180), entry.index!);
      expect(before, `"${entry[0]}" is not gated`).toContain('canOperateUnionNetwork');
    }
  });

  it('does not build the Community Center entry without the answer', () => {
    const page = read('src/pages/workspaces/ArenaWorkspacePages.tsx');
    const unionLink = page.indexOf("label: 'Union Network'");
    expect(unionLink).toBeGreaterThan(-1);
    expect(page.slice(Math.max(0, unionLink - 200), unionLink)).toContain('canOperateUnionNetwork');
  });
});
