import type { Page, Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sliceMethod } from '../helpers/sourceWindow';

const { hidden } = vi.hoisted(() => ({ hidden: vi.fn(async () => undefined) }));
vi.mock('@playwright/test', () => ({
  expect: Object.assign(
    vi.fn(() => ({ toBeHidden: hidden })),
    {
      poll: vi.fn((read: () => Promise<unknown>) => ({
        not: {
          toBe: async (value: unknown) => {
            for (let attempt = 0; attempt < 5; attempt += 1) {
              if ((await read()) !== value) return;
            }
            throw new Error(`still ${String(value)}`);
          },
        },
      })),
    }
  ),
  chromium: {},
}));

import {
  DIAMOND_DECLINE_CLICK_TIMEOUT_MS,
  prepareCashLobbyActions,
  registerDiamondInvitationDismissal,
} from '../e2e/support/cashLobbyOverlays';
import {
  DIAMOND_ENTRY_READ,
  DIAMOND_SPINS_SMALLEST_ENTRY,
  offersDiamondSpins,
  settleDiamondSpinsOffer,
} from '../e2e/support/diamondInvitationOffer';

/**
 * Phase 11 line 4 (docs/evidence/diamond-phase-11/shared-regression.md): the
 * Diamond Spins offer on the shared chip lobby made Post-Deploy E2E runs
 * 36541808365, 36622883035, 36642628863 and 36679411337 fail
 * production-mobile-lobby-chrome.spec.ts before the lobby was measured. The spec
 * now settles that offer at a point of its own choosing; this file keeps the
 * helper's reading of the offer equal to the component's.
 */
const source = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');

const OFFER = { ok: true, bust_prompt: true, member_chips: 0, diamonds: 500 };

function response(status: number, body: unknown): Response {
  return {
    status: () => status,
    json: async () => body,
  } as unknown as Response;
}

function page(states: string[]) {
  let last = 'pending';
  const click = vi.fn(async () => undefined);
  const notNow = { click, evaluate: vi.fn(async () => null) };
  const prompt = {
    getByRole: vi.fn(() => notNow),
    isVisible: vi.fn(async () => last === 'open'),
  };
  const evaluate = vi.fn(async () => (last = states.shift() ?? last));
  const removeLocatorHandler = vi.fn(async () => undefined);
  return {
    page: { evaluate, removeLocatorHandler, getByRole: vi.fn(() => prompt) } as unknown as Page,
    evaluate,
    removeLocatorHandler,
    click,
  };
}

describe('the Diamond Spins offer is settled before the lobby is measured', () => {
  it('reads the offer exactly as DiamondBustPrompt decides it', () => {
    const prompt = source('src/components/games/DiamondBustPrompt.tsx');
    expect(prompt).toContain(
      'entry?.bust_prompt === true && entry.member_chips === 0 && entry.diamonds >= 25'
    );
    expect(DIAMOND_SPINS_SMALLEST_ENTRY).toBe(25);
    expect(prompt).toContain('ariaLabel="Diamond Spins"');
    expect(prompt).toContain('`diamond-spins-bust:${');
    expect(prompt).toContain("sessionStorage.setItem(key, 'dismissed')");
    expect(prompt).toContain("secondary: { label: 'Not Now', onClick: close }");
    expect(source('src/services/DiamondGamesService.ts')).toContain(
      "supabase.rpc('fn_diamond_games_entry', { p_club_id: clubId })"
    );
    expect(DIAMOND_ENTRY_READ).toBe('/rest/v1/rpc/fn_diamond_games_entry');

    expect(offersDiamondSpins(200, OFFER)).toBe(true);
    expect(offersDiamondSpins(200, { ...OFFER, diamonds: 25 })).toBe(true);
    expect(offersDiamondSpins(200, { ...OFFER, diamonds: 24 })).toBe(false);
    expect(offersDiamondSpins(200, { ...OFFER, member_chips: 1 })).toBe(false);
    expect(offersDiamondSpins(200, { ...OFFER, member_chips: null })).toBe(false);
    expect(offersDiamondSpins(200, { ...OFFER, bust_prompt: false })).toBe(false);
    expect(offersDiamondSpins(200, { ...OFFER, ok: false })).toBe(false);
    expect(offersDiamondSpins(500, OFFER)).toBe(false);
    expect(offersDiamondSpins(200, null)).toBe(false);
  });

  it('does nothing when the lobby never asked or made no offer', async () => {
    const quiet = page([]);
    await expect(settleDiamondSpinsOffer(quiet.page, Promise.resolve(null))).resolves.toBe(
      'unknown'
    );
    await expect(
      settleDiamondSpinsOffer(
        quiet.page,
        Promise.resolve(response(200, { ...OFFER, member_chips: 7 }))
      )
    ).resolves.toBe('not offered');
    expect(quiet.evaluate).not.toHaveBeenCalled();
    expect(quiet.removeLocatorHandler).not.toHaveBeenCalled();
  });

  it('waits for an offered invitation, retires the handler and takes the real Not Now', async () => {
    const offered = page(['pending', 'open']);
    await expect(
      settleDiamondSpinsOffer(offered.page, Promise.resolve(response(200, OFFER)))
    ).resolves.toBe('declined');
    expect(offered.evaluate).toHaveBeenCalledTimes(2);
    expect(offered.removeLocatorHandler).toHaveBeenCalledTimes(1);
    expect(offered.click).toHaveBeenCalledWith({ timeout: DIAMOND_DECLINE_CLICK_TIMEOUT_MS });
    expect(hidden).toHaveBeenCalledTimes(1);
  });

  it('does not click again when the handler already declined it', async () => {
    const declined = page(['declined']);
    await settleDiamondSpinsOffer(declined.page, Promise.resolve(response(200, OFFER)));
    expect(declined.removeLocatorHandler).toHaveBeenCalledTimes(1);
    expect(declined.click).not.toHaveBeenCalled();
  });

  it('retains an original handler failure when retirement sees the invitation already hidden', async () => {
    const intercepted = new Error('locator.click: another layer intercepts pointer events');
    const click = vi.fn().mockRejectedValue(intercepted);
    const notNow = { click, evaluate: vi.fn(async () => null) };
    const prompt = { getByRole: vi.fn(() => notNow), isVisible: vi.fn(async () => false) };
    let handler: () => Promise<void> = async () => undefined;
    const ownedPage = {
      getByRole: vi.fn(() => prompt),
      addLocatorHandler: vi.fn(async (_locator: unknown, callback: () => Promise<void>) => {
        handler = callback;
      }),
      removeLocatorHandler: vi.fn(async () => undefined),
    } as unknown as Page;
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(ownedPage, {
      onFailure: (error) => failures.push(error),
    });
    await handler();
    expect(failures).toHaveLength(1);
    await expect(
      prepareCashLobbyActions(ownedPage, { retainInvitationHandler: false })
    ).rejects.toBe(failures[0]);
    expect((failures[0] as Error).cause).toBe(intercepted);
    expect(prompt.isVisible).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('is wired into the live lobby before any measurement', () => {
    const spec = source('tests/e2e/production-mobile-lobby-chrome.spec.ts');
    const openLobby = sliceMethod(spec, 'async function openLobby(page: Page)');
    const order = [
      'const offer = diamondEntryRead(page);',
      'await page.goto(',
      'await prepareCashLobbyActions(page);',
      'lobby-wallets-trigger',
      'await settleDiamondSpinsOffer(page, offer);',
    ].map((needle) => openLobby.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
