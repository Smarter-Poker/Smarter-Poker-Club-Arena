/**
 * Dan 2026-08-30: "IT SHOULD NEVER HAVE 'RE ENTRY' AS A FIELD, ONLY REBUYS...
 * AND EACH PAGE NEEDS TO BE SCROLLABLE UP AND DOWN. YOU CURRENTLY CAN'T."
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRIES = fs.readFileSync(
  path.join(ROOT, 'src/components/tournament/details/EntriesTab.tsx'),
  'utf8'
);
/* 2026-10-04: PremiumTournamentConsole.css is deleted (Dan: "remove all these
   large frames"). The shell has ONE stylesheet now, so the scroll contract
   has one place to live and nothing at a higher specificity to restate it
   against. The guarantee this case defends is unchanged: every tab scrolls. */
const SHELL = fs.readFileSync(
  path.join(ROOT, 'src/pages/tournament/TournamentDetails.css'),
  'utf8'
);

describe('the entries stats never surface a Re-Entry field', () => {
  it('EntriesTab renders no Re-Entry stat or sub-label', () => {
    // The quoted ruling in the comment is allowed; a rendered string is not.
    const rendered = ENTRIES.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rendered).not.toMatch(/Re-Entry</);
    expect(rendered).not.toMatch(/toLocaleString\(\)\} Re-Entry/);
  });
});

describe('the lobby shell keeps the scroll contract', () => {
  it('.details-content scrolls vertically', () => {
    // Anchored on the rule's own opening line: the selector is also quoted in
    // the comments above it, and a comment has no declarations to assert on.
    const start = SHELL.search(/^\.details-content \{$/m);
    expect(start).toBeGreaterThan(-1);
    const rule = SHELL.slice(start, SHELL.indexOf('}', start));
    expect(rule).toMatch(/overflow-y: auto/);
    expect(rule).toMatch(/min-height: 0/);
    expect(rule).toMatch(/flex: 1 1 auto/);
    expect(rule).not.toMatch(/overflow-y: hidden/);
  });
});

describe('the entry register stays live while the event does', () => {
  it('re-runs the one detail query on a cadence for live events only', () => {
    expect(ENTRIES).toMatch(/tournamentLive/);
    expect(ENTRIES).toMatch(/20_000/);
    expect(ENTRIES).toMatch(/visibilityState === 'visible'/);
    // History does not poll: the schedule stands down for finished events.
    expect(ENTRIES).toMatch(/if \(cancelled \|\| !tournamentLive\) return;/);
  });
});
