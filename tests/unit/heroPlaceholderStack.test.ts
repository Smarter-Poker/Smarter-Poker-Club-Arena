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

function placeholder(
  rowStack: number | null,
  pendingStack = 400,
  lightningWaitingSeat: { status: string; stack: number | null } | null = null,
  /* Lightning transition, phase 1: the Lightning waiting chair's face, worked
     out above the seat loop (lightningStandInIdentity). Null at Classic. */
  lightningStandIn: { name: string; avatar: string; frame?: string; aura?: string } | null = null,
  heroSitsOutPerRow = true
) {
  return new Function(
    'heroRowStack',
    'pendingSeatStackRef',
    'lightningWaitingSeat',
    'lightningStandIn',
    'heroSitsOutPerRow',
    `let displayPlayer = null;
     const pendingSeat = null, seatNumber = 8, tableState = { heroSeat: 8 };
     const userId = 'hero', username = 'Player', heroAvatarUrl = '';
     ${branch}
     return displayPlayer;`
  )(rowStack, { current: pendingStack }, lightningWaitingSeat, lightningStandIn, heroSitsOutPerRow);
}

describe('hero placeholder identity', () => {
  it('a Classic stand-in is the username with no cosmetics, as before', () => {
    const chair = placeholder(100);
    expect(chair.name).toBe('Player');
    expect(chair.frame).toBeUndefined();
    expect(chair.aura).toBeUndefined();
  });
  it("a Lightning waiting chair wears the hand's alias, frame and aura", () => {
    const chair = placeholder(
      null,
      0,
      { status: 'active', stack: 250 },
      { name: 'The Closer', avatar: '/a.webp', frame: 'frame-gold', aura: 'aura-fire' }
    );
    expect(chair).toMatchObject({
      name: 'The Closer',
      avatar: '/a.webp',
      frame: 'frame-gold',
      aura: 'aura-fire',
      stack: 250,
      status: 'active',
      isHero: true,
    });
  });
});

describe('hero placeholder stack', () => {
  it('marks an unknown Lightning stack pending while preserving confirmed zero', () => {
    expect(placeholder(null, 0, { status: 'active', stack: null }).stackPending).toBe(true);
    const known = placeholder(null, 0, { status: 'active', stack: 0 });
    expect(known.stackPending).toBe(false);
    expect(known.stack).toBe(0);
  });
  it('retires the original buy-in after the authoritative row arrives', () => {
    const rowStart = page.indexOf('        {\n          const rowStack = heroRow?');
    const rowEnd = page.indexOf('        const stillSeated', rowStart);
    if (rowStart < 0 || rowEnd < rowStart) throw new Error('Seat balance read not found');
    const read = ts.transpile(page.slice(rowStart, rowEnd));
    const pending = { current: 400 };
    let balance: number | null = null;
    new Function('heroRow', 'pendingSeatStackRef', 'setHeroRowStack', read)(
      { stack: '528.70' },
      pending,
      (update: (previous: number | null) => number | null) => {
        balance = update(balance);
      }
    );
    expect(balance).toBe(528.7);
    expect(pending.current).toBe(0);
  });

  it('keeps the current 528.70 stack after sitting out instead of the original 400 buy-in', () => {
    expect(placeholder(528.7).stack).toBe(528.7);
  });

  it('shows a confirmed zero stack without resurrecting the buy-in', () => {
    expect(placeholder(0).stack).toBe(0);
  });

  it('shows the confirmed buy-in while the seat row has not arrived', () => {
    expect(placeholder(null).stack).toBe(400);
  });

  it('shows a confirmed waiting entrant without an invented sitting-out tag', () => {
    expect(placeholder(20000, 0, null, null, false).status).toBe('active');
  });

  it('is still sitting out at a cash table', () => {
    expect(placeholder(528.7).status).toBe('sitting_out');
  });

  /* Dan 2026-10-24: a Lightning room has no seat row and no pending buy-in, so
     the chair printed 0.00 and SITTING OUT after every fold. */
  it('shows a Lightning player their balance and no SITTING OUT between hands', () => {
    const hero = placeholder(null, 0, { status: 'active', stack: 187.5 });
    expect(hero.stack).toBe(187.5);
    expect(hero.status).toBe('active');
    expect(hero.stackPending).toBe(false);
  });
});
