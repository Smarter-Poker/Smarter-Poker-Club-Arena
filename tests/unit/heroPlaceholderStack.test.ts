import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the actual render branch. An old buy-in must never shadow the
// current seat balance when the engine omits a sitting-out hero from a hand.
const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
const start = page.indexOf('if (\n              !displayPlayer &&');
const end = page.indexOf('// THE CHIP RAIL.', start);
if (start < 0 || end < start) throw new Error('Hero placeholder branch not found');
const branch = ts.transpile(page.slice(start, end), { target: ts.ScriptTarget.ES2022 });

function placeholder(rowStack: number | null, pendingStack = 400) {
  return new Function(
    'heroRowStack',
    'pendingSeatStackRef',
    `let displayPlayer = null;
     const pendingSeat = null, seatNumber = 8, tableState = { heroSeat: 8 };
     const userId = 'hero', username = 'Player', heroAvatarUrl = '';
     ${branch}
     return displayPlayer;`
  )(rowStack, { current: pendingStack });
}

describe('hero placeholder stack', () => {
  it('keeps the current 528.70 stack after sitting out instead of the original 400 buy-in', () => {
    expect(placeholder(528.7).stack).toBe(528.7);
  });

  it('shows a confirmed zero stack without resurrecting the buy-in', () => {
    expect(placeholder(0).stack).toBe(0);
  });

  it('shows the confirmed buy-in while the seat row has not arrived', () => {
    expect(placeholder(null).stack).toBe(400);
  });
});
