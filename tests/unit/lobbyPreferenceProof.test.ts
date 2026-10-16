import type { Page, Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isLobbySelectionSave, restoreLobbyPreference } from '../e2e/support/lobbyPreferenceProof';

const club = 'certificate-club';
function response(body: unknown, overrides: { ok?: boolean; method?: string; path?: string } = {}) {
  return {
    ok: () => overrides.ok ?? true,
    url: () => `https://example.test${overrides.path ?? '/rest/v1/user_lobby_filters'}`,
    request: () => ({
      method: () => overrides.method ?? 'POST',
      postDataJSON: () => {
        if (body instanceof Error) throw body;
        return body;
      },
    }),
  } as unknown as Response;
}

describe('cold-return preference proof', () => {
  it('acknowledges the intended tab and club, excluding the other endpoint writer', () => {
    expect(
      isLobbySelectionSave(response({ club_id: club, view_prefs: { tab: 'OMAHA' } }), club, 'PLO')
    ).toBe(true);
    for (const body of [
      { club_id: 'another-club', view_prefs: { tab: 'OMAHA' } },
      { club_id: club, view_prefs: { tab: 'HOLDEM' } },
      { club_id: club, filters: {} },
      null,
      [],
      new Error('invalid JSON'),
    ])
      expect(isLobbySelectionSave(response(body), club, 'PLO')).toBe(false);
    for (const override of [{ ok: false }, { method: 'GET' }, { path: '/rest/v1/clubs' }])
      expect(
        isLobbySelectionSave(
          response({ club_id: club, view_prefs: { tab: 'OMAHA' } }, override),
          club,
          'PLO'
        )
      ).toBe(false);
    expect(() => isLobbySelectionSave(response({}), club, 'unknown')).toThrow('Unknown lobby tab');
  });

  function page(name: string, events: string[], fail = false) {
    return {
      waitForResponse: async (predicate: (response: Response) => boolean) => {
        events.push(`${name}:listen`);
        expect(predicate(response({ club_id: club, view_prefs: { tab: 'MTT' } }))).toBe(true);
        if (fail) throw new Error('restoration acknowledgement failed');
      },
      getByRole: () => ({
        getByRole: () => ({
          click: async () => {
            events.push(`${name}:click`);
          },
        }),
      }),
      close: async () => {
        events.push(`${name}:close`);
      },
    } as unknown as Page;
  }

  it.each([true, false])(
    'restores on the ready document before verification and close (ready=%s)',
    async (ready) => {
      const events: string[] = [];
      await restoreLobbyPreference({
        originalPage: page('old', events),
        returningPage: page('new', events),
        returningReady: ready,
        clubId: club,
        original: 'MTT',
        verify: async () => {
          events.push('verify');
        },
      });
      expect(events).toEqual([
        `${ready ? 'new' : 'old'}:listen`,
        `${ready ? 'new' : 'old'}:click`,
        'verify',
        'new:close',
      ]);
    }
  );

  it('keeps failed restoration red and still closes its owned document', async () => {
    const events: string[] = [];
    const verify = vi.fn();
    await expect(
      restoreLobbyPreference({
        originalPage: page('old', events),
        returningPage: page('new', events, true),
        returningReady: true,
        clubId: club,
        original: 'MTT',
        verify,
      })
    ).rejects.toThrow('restoration acknowledgement failed');
    expect(verify).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('new:close');
  });

  it('wires exact acknowledgement and restoration with a fresh persisted readback into production', () => {
    const source = readFileSync(
      resolve(__dirname, '../e2e/production-mobile-lobby-chrome.spec.ts'),
      'utf8'
    );
    expect(source).toContain('await selectLobbyPreference(page, CLUB_ID, target)');
    expect(source).toContain('await restoreLobbyPreference({');
    expect(source).toContain('await openLobby(restoredPage)');
    expect(source).toContain(".getByRole('tab', { name: original, exact: true })");
    expect(source).toContain('failures.push(error)');
    expect(source).toContain('failures.push(cleanupError)');
    expect(source).toContain('new AggregateError(failures,');
    expect(source).toContain('if (failures.length === 1) throw failures[0]');
  });
});
