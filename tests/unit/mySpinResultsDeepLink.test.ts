/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MY SPIN RESULTS — the history that already existed becomes reachable
 *  (2026-08-29, round 10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TournamentResultsPage has carried a Mine filter, a Spin type filter, the
 * multiplier badge and isMe highlighting for weeks - and no surface could
 * ARRIVE at that view: the filters lived only in component state. Round 10
 * makes them deep-linkable (?filter=mine&type=spin) and adds the hamburger
 * entry that links there, so a spin player reaches their own history in one
 * tap.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const RESULTS = readFileSync(
  join(root, 'src', 'pages', 'tournament', 'TournamentResultsPage.tsx'),
  'utf8'
);
const NAVIGATION = readFileSync(join(root, 'src', 'config', 'clubArenaNavigation.ts'), 'utf8');
const PRELOADER = readFileSync(join(root, 'src', 'utils', 'ChunkPreloader.ts'), 'utf8');

describe('the results filters are deep-linkable', () => {
  it('initialises filter and type from the URL, validated', () => {
    expect(RESULTS).toContain("searchParams.get('filter')");
    expect(RESULTS).toContain("searchParams.get('type')");
    expect(RESULTS).toContain("filterParam === 'mine' ? 'mine' : 'all'");
    expect(RESULTS).toContain('VALID_TYPE_FILTERS.includes(typeParam)');
  });

  it('the button row renders from the same validated list - the two cannot drift', () => {
    expect(RESULTS).toContain('VALID_TYPE_FILTERS.map((t) =>');
    // The old hand-written duplicate of the list next to the buttons is gone:
    // exactly one literal declaration of the type list survives.
    const declarations = RESULTS.match(/'freezeout',/g) || [];
    expect(declarations.length).toBe(1);
  });
});

describe('the hamburger links a spin player to their own history', () => {
  it('carries the My Spin Results entry with both params', () => {
    // Navigation entries are centrally owned by clubArenaNavigation and the
    // hamburger renders that registry. Pin the owning module so an IA cleanup
    // cannot silently strand this route merely by moving the menu markup.
    const start = NAVIGATION.indexOf("label: 'My Spin Results'");
    expect(start).toBeGreaterThan(-1);
    const entry = NAVIGATION.slice(start, start + 240);
    expect(entry).toContain('/tournament-results?filter=mine&type=spin');
  });

  it('the chunk preloader strips the query so the prefetch still lands', () => {
    const fn = sliceEnclosingBlock(PRELOADER, "path.split('?')[0]", 0, 1);
    expect(fn).toContain("path = path.split('?')[0]");
  });
});

describe('round 10: the results page reads bind their errors', () => {
  it('list, deep-link, standings and hands reads all act on failure', () => {
    expect(RESULTS).toContain('if (listErr) throw listErr');
    expect(RESULTS).toContain('deep_link_read_failed');
    expect(RESULTS).toContain('if (standingsErr) throw standingsErr');
    expect(RESULTS).toContain('if (handsErr) throw handsErr');
  });
});
