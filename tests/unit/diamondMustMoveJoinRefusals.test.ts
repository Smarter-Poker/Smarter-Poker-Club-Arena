import { describe, expect, it } from 'vitest';
import { joinGameRefusalText } from '../../src/services/cashGameLobby';

describe('Diamond game entry names its own asset and refusal', () => {
  it('shows the whole settled Diamond requirement', () => {
    expect(joinGameRefusalText({ message: 'INSUFFICIENT_SETTLED_DIAMONDS:4000' })).toBe(
      'Not Enough Settled Diamonds. You Need At Least 4,000 Diamonds To Join This Game.'
    );
    expect(joinGameRefusalText({ message: 'INSUFFICIENT_SETTLED_DIAMONDS:unknown' })).toBe(
      'Not Enough Settled Diamonds To Join This Game.'
    );
  });
  it('names debt and a revoked session without asking a player to retry funding', () => {
    expect(joinGameRefusalText({ message: 'diamond_debt_requires_settlement' })).toContain(
      'Settle Your Outstanding Diamonds'
    );
    expect(joinGameRefusalText({ message: 'SESSION_REVOKED: sign in again' })).toContain(
      'Sign In Again'
    );
  });
  it('retains the chip-game sentence', () => {
    expect(joinGameRefusalText({ message: 'INSUFFICIENT_CHIPS:12.5' })).toBe(
      'Not Enough Chips. You Need At Least 12.5 Chips To Join This Game.'
    );
  });
});
