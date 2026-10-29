import { expect, it } from 'vitest';
import { hasNewThirdPartyPreflopContribution as changed } from './HorseManiacPressure.test-support.js';
const action = (userId: string, action: string, amount = 0, stage = 'preflop') => ({
  userId,
  action,
  amount,
  stage,
});
const open = action('hero', 'raise', 6);
const reraise = action('target', 'raise', 21);
it.each(['call', 'raise', 'all_in'])(
  'recognizes a new positive third-party %s before or after the re-raise',
  (kind) => {
    expect(changed([open, action('other', kind, 6), reraise], 'hero', 'target')).toBe(true);
    expect(changed([open, reraise, action('other', kind, 21)], 'hero', 'target')).toBe(true);
  }
);
it.each(['small_blind', 'big_blind', 'ante', 'check', 'fold'])(
  'does not exclude a %s or untouched pending seat',
  (kind) => {
    expect(changed([open, action('other', kind, 2), reraise], 'hero', 'target')).toBe(false);
    expect(changed([open, reraise], 'hero', 'target')).toBe(false);
  }
);
it('requires new investment after the latest hero raise, not an earlier limp or call', () => {
  expect(changed([action('other', 'call', 2), open, reraise], 'hero', 'target')).toBe(false);
  expect(
    changed(
      [open, action('other', 'call', 6), action('hero', 'raise', 30), reraise],
      'hero',
      'target'
    )
  ).toBe(false);
  expect(changed([action('other', 'call', 2), reraise], 'hero', 'target')).toBe(false);
});
it.each([0, -1, NaN, Infinity])('rejects nonpositive or nonfinite contributions: %s', (amount) => {
  expect(changed([open, action('other', 'call', amount), reraise], 'hero', 'target')).toBe(false);
});
it('does not count the target, hero, missing identity, or another street', () => {
  for (const a of [
    action('target', 'call', 6),
    action('hero', 'call', 6),
    action('', 'call', 6),
    action('other', 'call', 6, 'flop'),
  ]) {
    expect(changed([open, a, reraise], 'hero', 'target')).toBe(false);
  }
});
