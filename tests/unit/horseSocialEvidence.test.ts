import { describe, expect, it } from 'vitest';
import {
  horseSocialFrames,
  postHandChatDelay,
  sharedPayout,
} from '../e2e/support/horseSocialEvidence';

describe('natural horse social evidence', () => {
  it('extracts nested public CHAT facts without auth or private gameplay payloads', () => {
    expect(
      horseSocialFrames(
        {
          apiKey: 'not-evidence',
          payload: {
            type: 'CHAT',
            sender: 'horse',
            payload: { message: '[THROW:rose:3]', throwId: 'receipt' },
            privateCards: ['not-evidence'],
          },
        },
        100
      )
    ).toEqual([{ at: 100, sender: 'horse', message: '[THROW:rose:3]', throwId: 'receipt' }]);
    expect(horseSocialFrames({ type: 'AUTH', payload: { token: 'not-evidence' } }, 100)).toEqual(
      []
    );
  });
  it('measures the visible chat timestamp, not the earlier claim', () => {
    expect(postHandChatDelay('2026-10-28T09:10:00Z', '2026-10-28T09:10:05Z')).toBe(5000);
    expect(postHandChatDelay('2026-10-28T09:10:00Z', '2026-10-28T09:10:04.999Z')).toBe(4999);
    expect(() => postHandChatDelay('', '')).toThrow();
  });
  it('distinguishes shared payouts from multiple pots paid to one player', () => {
    expect(sharedPayout([{ userId: 'a' }, { userId: 'b' }])).toBe(true);
    expect(sharedPayout([{ userId: 'a' }, { userId: 'a' }])).toBe(false);
    expect(() => sharedPayout(null)).toThrow();
    expect(() => sharedPayout([{}])).toThrow();
  });
});
