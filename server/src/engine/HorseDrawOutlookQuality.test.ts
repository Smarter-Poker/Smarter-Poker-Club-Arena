import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { nextCardOutlook, variantInfo } from './HorseEval.js';
const suits = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const;
const cards = (s: string): Card[] =>
  s
    .split(' ')
    .map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1] as keyof typeof suits] }));
const outlook = (hole: string, board: string) =>
  nextCardOutlook(cards(hole), cards(board), variantInfo('nlh'));
describe('holdem barrel plans discount shared improvements and dirty outs', () => {
  it('a shared board pair does not promote a pocket pair into a value barrel', () => {
    expect(outlook('5h 5d', 'As Kd 7c').good).not.toContain('7d');
  });
  it('preserves the original algorithm for independent paired comparisons', () => {
    const old = nextCardOutlook(cards('7d 8d'), cards('5h 9h 2c'), variantInfo('nlh'), false);
    expect(old.good).toContain('6h');
    for (const variant of ['plo4', 'short_deck']) {
      const hole = cards(variant === 'plo4' ? 'Ah Kh 7c 8c' : 'Ah Kh');
      const board = cards('Qh Jh 9d');
      expect(nextCardOutlook(hole, board, variantInfo(variant))).toEqual(
        nextCardOutlook(hole, board, variantInfo(variant), false)
      );
    }
  });

  it('a board pair is not a private improvement for unpaired air', () => {
    expect(outlook('9h 8h', 'As Kd 7c').good).not.toContain('7d');
  });
  it('a private pair and an uncontaminated straight remain good cards', () => {
    expect(outlook('9h 8h', 'As Kd 7c').good).toContain('9d');
    expect(outlook('7d 8d', '5h 9h 2c').good).toContain('6c');
  });
  it('a straight out completing an unblocked flush is scary, not clean value', () => {
    const o = outlook('7d 8d', '5h 9h 2c');
    expect(o.good).not.toContain('6h');
    expect(o.scare).toContain('6h');
  });
  it('four connected ranks are scary when hero has no straight', () => {
    expect(outlook('As Ad', '9h Tc Jd').scare).toContain('Qs');
  });
  it('does not label a nut-straight completion as scary', () => {
    const o = outlook('As Kd', 'Th Jc 2d');
    expect(o.good).toContain('Qh');
    expect(o.scare).not.toContain('Qh');
  });
});

describe('Omaha dirty-flush continuation cards', () => {
  it.each([
    ['plo4', 'Ad Ks Qh Jc'],
    ['plo5', 'Ad Ks Qh Jc Tc'],
    ['plo6', 'Ad Ks Qh Jc Tc 3h'],
  ])('%s keeps third-diamond pair and straight improvements in the scare set', (variant, hole) => {
    const board = cards('9d 8d 2s');
    const legacy = nextCardOutlook(cards(hole), board, variantInfo(variant), false);
    const corrected = nextCardOutlook(cards(hole), board, variantInfo(variant));
    for (const dirty of ['Td', 'Kd']) {
      expect(legacy.good).toContain(dirty);
      expect(corrected.good).not.toContain(dirty);
      expect(corrected.scare).toContain(dirty);
    }
    expect(corrected.good).toContain('Th');
    expect(corrected.good).toContain('Kh');
  });

  it('retains a real Omaha flush improvement with two suited hole cards', () => {
    const o = nextCardOutlook(cards('Ad Kd Qh Jc Tc'), cards('9d 4d 2s'), variantInfo('plo5'));
    expect(o.good).toContain('3d');
    expect(o.scare).not.toContain('3d');
  });
});

it.each([
  ['plo5', 'Ad Kd Qh Jc Tc', '9d 4d 2d'],
  ['plo5', '9h 9c Kd Qc Th', '9d 2d 2s'],
  ['plo8', 'Ad Ks Qh Jc', '9d 8d 2s'],
  ['flo8', 'Ad Ks Qh Jc', '9d 8d 2s'],
])('preserves the %s made-flush/full-house or hi-lo baseline: %s on %s', (variant, hole, board) => {
  expect(nextCardOutlook(cards(hole), cards(board), variantInfo(variant))).toEqual(
    nextCardOutlook(cards(hole), cards(board), variantInfo(variant), false)
  );
});
