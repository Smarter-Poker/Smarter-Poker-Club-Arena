import { describe, expect, it } from 'vitest';
import { expectedPlayableWalletFigure } from '../e2e/support/walletPlayableAmount';
import {
  isLobbyPreferenceSave,
  LOBBY_COLD_RETURN_TIMEOUT_MS,
  LOBBY_SAVE_TIMEOUT_MS,
  withLobbyPreferenceRestoration,
} from '../e2e/support/lobbyPreferenceCertificate';

describe('the owner-required playable wallet display', () => {
  it.each([
    [0, '0.00'],
    [0.25, '0.25'],
    [1000, '1,000.00'],
    [12164.92, '12,164.92'],
    [999999.99, '999,999.99'],
    [1000000, '1M'],
    [1234567, '1.2M'],
    [1000000000, '1B'],
  ])('preserves actual available amount %s as %s', (amount, expected) => {
    expect(expectedPlayableWalletFigure(amount as number)).toBe(expected);
  });
  it.each([NaN, Infinity, -1])('refuses an unreadable available amount %s', (amount) => {
    expect(() => expectedPlayableWalletFigure(amount)).toThrow();
  });
});

describe('cold lobby preference proof', () => {
  const row = { user_id: 'owner', club_id: 'club', view_prefs: { tab: 'OMAHA' } };
  it('requires the exact owner, club and selected preference, including a single upsert row', () => {
    expect(isLobbyPreferenceSave(row, 'owner', 'club', 'PLO')).toBe(true);
    expect(isLobbyPreferenceSave([row], 'owner', 'club', 'PLO')).toBe(true);
    expect(isLobbyPreferenceSave(row, 'other', 'club', 'PLO')).toBe(false);
    expect(isLobbyPreferenceSave(row, 'owner', 'other', 'PLO')).toBe(false);
    expect(isLobbyPreferenceSave(row, 'owner', 'club', 'NLH')).toBe(false);
    expect(isLobbyPreferenceSave({ ...row, view_prefs: undefined }, 'owner', 'club', 'PLO')).toBe(
      false
    );
    expect(isLobbyPreferenceSave([row, row], 'owner', 'club', 'PLO')).toBe(false);
  });
  it('preserves the journey failure when restoration also fails', async () => {
    const initial = new Error('target preference did not persist');
    let restored = false;
    await expect(
      withLobbyPreferenceRestoration(
        async () => {
          throw initial;
        },
        async () => {
          restored = true;
          throw new Error('restore response absent');
        }
      )
    ).rejects.toBe(initial);
    expect(restored).toBe(true);
  });
  it('still fails when only restoration fails', async () => {
    const failure = new Error('original preference did not restore');
    await expect(
      withLobbyPreferenceRestoration(
        async () => {},
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
  });
  it('accounts for both existing document budgets without extending the bounded writes', () => {
    expect(LOBBY_SAVE_TIMEOUT_MS).toBe(30_000);
    expect(LOBBY_COLD_RETURN_TIMEOUT_MS).toBe(2 * 120_000 + 2 * 30_000);
  });
});
