import { describe, expect, it } from 'vitest';
import { produceRiverCallFoldReference, type RiverReferenceInput } from './riverReference.js';
import { cards, bind, riverReferenceFixture as input } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';

describe('offline Phase 14 river call/fold reference producer', () => {
  it.each([
    'nlh',
    'flh',
    'pineapple',
    'short_deck',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
  ] as const)('prices a known winning terminal call under %s card rules', (variant) => {
    const i = input();
    i.domain.variant = variant;
    const count =
      variant === 'plo5'
        ? 5
        : variant === 'plo6'
          ? 6
          : ['plo4', 'plo8', 'flo8'].includes(variant)
            ? 4
            : 2;
    i.hero = cards('As Ah 2s 3s 4s 5s'.split(' ').slice(0, count).join(' '));
    i.range = [
      { cards: cards('Ks Kh 2h 3h 4h 5h'.split(' ').slice(0, count).join(' ')), weight: 1 },
    ];
    const r = produceRiverCallFoldReference(bind(i));
    expect(r.status).toBe('produced');
    // A-7-8 plus each player's 2-3 ties the low: hero takes all high
    // and half low, 3/4 of 146 after rake, less the 50 call, over 2 BB.
    const expected = variant === 'plo8' || variant === 'flo8' ? 29.75 : 48;
    if (r.status === 'produced') expect(r.reference.alternatives[1]!.mean).toBe(expected);
  });
  it.each(['schema', 'folded-hero', 'all-in-hero'])(
    'refuses an impossible original %s state',
    (kind) => {
      const i = input();
      if (kind === 'schema') i.original.snapshot.gameState.stateSchemaVersion = 0 as never;
      if (kind === 'folded-hero') i.original.snapshot.player.is_folded = true;
      if (kind === 'all-in-hero') i.original.snapshot.player.is_all_in = true;
      i.binding.inputDigest = evidenceDigest(i.original.snapshot);
      expect(produceRiverCallFoldReference(i).status).toBe('unavailable');
    }
  );
  it('prices the complete declared range after the original call cost and final rake', () => {
    const result = produceRiverCallFoldReference(input());
    expect(result.status).toBe('produced');
    if (result.status !== 'produced') throw Error(result.reason);
    expect(result.reference.alternatives).toEqual([
      { choice: { action: 'fold', amount: 0 }, mean: 0, lower: 0, upper: 0 },
      { choice: { action: 'call', amount: 50 }, mean: 48, lower: 48, upper: 48 },
    ]);
    expect(result).toMatchObject({ qualified: false, activationAllowed: false });
    expect(result.reference.binding).toEqual(input().binding);
    expect(result.reference.evidenceClass).toBe('synthetic_fixture');
    expect(result.reference).not.toHaveProperty('authority');
  });

  it('uses range weights and refunds the correct share on ties', () => {
    const i = input();
    i.board = cards('2s 3s 4s 5s 6s');
    i.hero = cards('Ah Ad');
    i.range = [
      { cards: cards('Kh Kd'), weight: 3 },
      { cards: cards('7s 7d'), weight: 1 },
    ];
    i.finalRake = 0;
    const r = produceRiverCallFoldReference(bind(i));
    expect(r.status).toBe('produced');
    if (r.status === 'produced') expect(r.reference.alternatives[1]!.mean).toBe(3.125);
  });

  it('uses exactly two Omaha hole cards and splits hi/lo, including quartering', () => {
    const i = input();
    i.domain.variant = 'plo8';
    i.hero = cards('As 2s Kh Kd');
    i.board = cards('3c 4d 8h Kc Qd');
    i.range = [{ cards: cards('Ah 2h Qc Qh'), weight: 1 }];
    i.finalRake = 0;
    const r = produceRiverCallFoldReference(bind(i));
    expect(r.status).toBe('produced');
    if (r.status === 'produced') expect(r.reference.alternatives[1]!.mean).toBe(31.25);
  });

  it.each([
    'hero',
    'board',
    'range',
    'contestablePot',
    'toCall',
    'stack',
    'bigBlind',
    'finalRake',
  ] as const)('refuses %s inconsistent with the original journal snapshot', (field) => {
    const i = input();
    if (field === 'hero') i.hero = cards('Qs Qh');
    else if (field === 'board') i.board = cards('2c 3d 4h 5c 6d');
    else if (field === 'range') i.range = [{ cards: cards('Qs Qh'), weight: 1 }];
    else i[field] += 1;
    expect(produceRiverCallFoldReference(i).status).toBe('unavailable');
  });

  it.each([
    ['future board', { stage: 'turn' }],
    ['multiple boards', { boardCount: 2 }],
    ['another responder', { opponents: 2 }],
    ['future opponent action', { opponentAllIn: false }],
    [
      'unpriced tournament utility',
      { domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' } },
    ],
    ['missing original range provenance', { rangeReadFrameDigest: '0'.repeat(64) }],
    ['uncallable chips', { toCall: 51 }],
    ['fractional cents', { toCall: 1.001 }],
    ['negative rake', { finalRake: -1 }],
    ['rake exceeds pot', { finalRake: 151 }],
    ['zero weight', { range: [{ cards: cards('Ks Kh'), weight: 0 }] }],
    ['future/hero card in range', { range: [{ cards: cards('As Kh'), weight: 1 }] }],
    [
      'duplicate range combo',
      {
        range: [
          { cards: cards('Ks Kh'), weight: 1 },
          { cards: cards('Kh Ks'), weight: 1 },
        ],
      },
    ],
  ])('refuses %s instead of fabricating a usable reference', (_name, change) => {
    expect(
      produceRiverCallFoldReference({ ...input(), ...change } as RiverReferenceInput).status
    ).toBe('unavailable');
  });

  it('binds enumeration inputs into the sampling contract and isolates output aliases', () => {
    const i = input();
    const a = produceRiverCallFoldReference(i);
    const expected = i.binding.inputDigest;
    const b = produceRiverCallFoldReference(bind({ ...structuredClone(i), finalRake: 3 }));
    expect(a.status).toBe('produced');
    expect(b.status).toBe('produced');
    if (a.status !== 'produced' || b.status !== 'produced') return;
    expect(a.reference.samplingContractDigest).not.toBe(b.reference.samplingContractDigest);
    i.binding.inputDigest = '9'.repeat(64);
    expect(a.reference.binding.inputDigest).toBe(expected);
  });
});
