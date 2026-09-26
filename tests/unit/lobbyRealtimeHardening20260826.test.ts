/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THREE WAYS THE LOBBY WENT QUIETLY STALE
 *  2026-08-26
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * None of these threw, logged, or changed a pixel at the moment they happened.
 * Each one left the board showing a number or a list that had simply stopped
 * being updated, which is the failure mode a player cannot report and an agent
 * cannot see. Source-text assertions, in the style of
 * lobbyCardsDoNotFlicker.test.ts, because the alternative is mounting a page
 * with six realtime subscriptions attached to it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock, sliceStatement } from '../helpers/sourceWindow';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
const WALLET = readFileSync(
  resolve(__dirname, '../../src/components/wallet/DynamicWallet.tsx'),
  'utf8'
);

describe('the lobby realtime channel can come back from the dead', () => {
  it('registers a recovery factory for the channel it creates', () => {
    // MasterBus reaps a dead channel and then looks for a factory to rebuild
    // it. With none registered it logs `No factory for "<key>" -- removed
    // only` and stops, and isCriticalChannelKey protects only
    // table-cards-secure-*. So one CHANNEL_ERROR used to end live tables,
    // tournaments AND the jackpot for the rest of the visit.
    expect(PAGE, 'the lobby channel has no recovery factory').toContain(
      'masterBus.registerChannelFactory(channelKey'
    );

    const register = PAGE.indexOf('masterBus.registerChannelFactory(channelKey');
    const create = PAGE.indexOf('masterBus.getOrCreateChannel(channelKey)');
    expect(create).toBeGreaterThan(-1);
    expect(
      register,
      'the factory must be registered BEFORE the channel exists, or a reap landing mid-setup has nothing to call'
    ).toBeLessThan(create);
  });

  it('drops the factory before removing the channel on unmount', () => {
    const drop = PAGE.indexOf('masterBus.removeChannelFactory(`club-tables-');
    const remove = PAGE.indexOf('masterBus.removeRegisteredChannel(`club-tables-');
    expect(drop, 'unmount does not remove the factory').toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(
      drop,
      'removing the channel while its factory is still registered invites the health monitor to rebuild the one we are tearing down'
    ).toBeLessThan(remove);
  });

  it('reports the subscribe status without touching a torn-down component', () => {
    const sub = PAGE.indexOf('channel.subscribe((status: string');
    expect(sub).toBeGreaterThan(-1);
    const body = sliceEnclosingBlock(PAGE, 'channel.subscribe((status: string');
    expect(body, 'a late CHANNEL_ERROR must not setState after unmount').toContain(
      'if (!isMounted) return;'
    );
  });
});

describe('a failed union lookup is not a standalone club', () => {
  it('checks the error on the union_clubs read instead of discarding it', () => {
    const start = PAGE.indexOf('const { data: ucCheck');
    expect(start, 'the setupRealtime union lookup is gone').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(PAGE, 'const { data: ucCheck');
    expect(block, 'the error is destructured away again').toContain('error: ucError');
    expect(block, 'a failed read must not be read as "no union"').toContain('if (ucError) throw');
  });

  it('falls back to the cached union rather than guessing standalone', () => {
    // loadClubData spends forty lines on exactly this law ("FAILURE IS NOT
    // ABSENCE") and writes the answer to sessionStorage under this key. The
    // realtime path had no fallback at all, so a blip unsubscribed the union
    // channels, admitted foreign rows into the table list, and pointed the BBJ
    // subscription at the retired club-level pool.
    const idx = PAGE.indexOf('ClubHomePage.setupRealtime');
    expect(idx).toBeGreaterThan(-1);
    const afterCatch = sliceEnclosingBlock(PAGE, 'ClubHomePage.setupRealtime');
    expect(afterCatch, 'no cached-union fallback on the failure path').toContain(
      'sessionStorage.getItem(`ca_union_of_'
    );
  });

  it('uses the same storage the writer uses', () => {
    // The writer is sessionStorage; reading localStorage would always miss.
    expect(PAGE).not.toContain('localStorage.getItem(`ca_union_of_');
  });
});

describe('the jackpot subscription watches the row the jackpot came from', () => {
  it('carries the pool id out of fn_club_money_panel into wallet state', () => {
    expect(WALLET, 'bbjPoolId is not part of WalletData').toMatch(/bbjPoolId:\s*string \| null;/);
    expect(WALLET, 'the panel response never populates it').toContain(
      'bbjPoolId: (bbj.pool_id as string | null) ?? null'
    );
  });

  it('reads the jackpot from the one shared source, not a scope of its own', () => {
    /* THE DEFECT THIS GUARDED IS NOW STRUCTURALLY IMPOSSIBLE (BBJ phase 3.2,
       2026-09-06). It pinned the wallet's own `bbj_pools` subscription to
       `id=eq.${bbjPoolId}`, because re-deriving the scope from currentUnionId
       sent a NON-MEMBER in a union club's lobby to that club's RETIRED pool
       row - a figure that was right at mount and then frozen for ever, which
       is worse than absent.

       There is no subscription to mis-scope any more. That row updated 40,219
       times in twenty-four hours (measured on production) and six surfaces
       each watched it; the wallet now follows the shared ten-second poll,
       whose scope is resolved SERVER-side by fn_bbj_pool_for_club - the same
       function the union rule lives in, rather than a fifth re-implementation
       of it. What is pinned is that the wallet does not go back to deriving
       its own. */
    expect(WALLET).toMatch(/watchBbjPool\(resolvedId,/);
    expect(WALLET, 'the wallet must not re-open a bbj_pools subscription').not.toMatch(
      /table: 'bbj_pools'/
    );
  });

  it('rebinds and releases the shared jackpot watch when the club resolves', () => {
    // The shared source resolves the pool on the server. The wallet must
    // return its unsubscribe and rebind on the resolved club, including when
    // switching into or out of the arena's diamond-only wallet.
    const watch = sliceEnclosingBlock(WALLET, 'return watchBbjPool(resolvedId,');
    expect(watch).toContain('if (!isMounted.current) return;');
    expect(WALLET).toContain('return watchBbjPool(resolvedId,');
    expect(WALLET).toMatch(/\}, \[resolvedId, hasChipWallet\]\);/);
  });
});

describe('the jackpot is a number every viewer gets, not a members-only figure', () => {
  it('renders "-" only for a genuinely empty pool, never for a refused read', () => {
    // fn_club_money_panel returns the bbj block on the not_a_member path as of
    // migration 20260825_bbj_visible_to_all_lobby_viewers, and DynamicWallet
    // reads `panel.bbj` regardless of the refusal. This pins the client half:
    // the dash is a function of the VALUE, not of authorisation.
    expect(WALLET).toContain("{data.bbjPool === 0 ? '-' : formatBalance(animBBJ)}");
    const banner = WALLET.indexOf('aria-label={`Bad Beat Jackpot:');
    expect(banner, 'the jackpot banner is gone').toBeGreaterThan(-1);
    const around = WALLET.slice(banner - 900, banner);
    expect(around, 'the banner must not be gated on scope or role').not.toMatch(
      /showBBJ && [^)]*scope/
    );
  });
});
