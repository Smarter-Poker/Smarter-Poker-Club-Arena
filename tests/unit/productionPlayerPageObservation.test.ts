import { describe, expect, it, vi } from 'vitest';
import { playerPageUnion } from '../e2e/club-data-deep.spec';

// Import the actual production oracle without registering browser cases in
// Vitest. The browser workflow still executes the original production spec.
vi.mock('@playwright/test', () => ({ test: { describe: () => undefined } }));

const page = (ids: string[]) => ({ rows: ids.map((user_id) => ({ user_id })), next_cursor: null });

describe('production player-page identity evidence', () => {
  it('qualifies each ranking separately when a live player crosses a page boundary', () => {
    const first = Array.from({ length: 100 }, (_, i) => `player-${i}`);
    const next = Array.from({ length: 100 }, (_, i) => `player-${i + 100}`);
    const movedNext = [first[99], ...next.slice(1)];
    expect(playerPageUnion(page(first), page(movedNext))).toHaveLength(199);
    expect(playerPageUnion(page(first), page(next))).toHaveLength(200);
    expect(playerPageUnion(page(first), page(movedNext))).not.toContain('player-100');
  });

  it('refuses a repeated identity within a response instead of concealing server duplicates', () => {
    expect(() => playerPageUnion(page(['a', 'a']))).toThrow('repeated an identity');
  });

  it('refuses malformed or missing response identity evidence', () => {
    expect(() => playerPageUnion(page(['']))).toThrow('invalid identity');
    expect(() => playerPageUnion({ rows: null } as never)).toThrow('no rows');
    expect(() => playerPageUnion({ rows: [{}] } as never)).toThrow('invalid identity');
  });

  it('retains every distinct first-page identity while adding only new continuation identities', () => {
    expect(playerPageUnion(page(['a', 'b']), page(['b', 'c']))).toEqual(['a', 'b', 'c']);
    expect(playerPageUnion(page(['a', 'b']), page(['b', 'a']))).toEqual(['a', 'b']);
  });
});
