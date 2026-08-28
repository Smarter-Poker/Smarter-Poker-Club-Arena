/**
 * AN EVENT THAT SAYS "THE BALANCE MOVED" MUST NOT BE SWALLOWED BY THE CACHE.
 *
 * useWalletStore.loadBalances/loadDiamonds gained a freshness window
 * (BALANCE_FRESH_MS) so that MOUNTING a component is free - that is what makes
 * navigating between Home, Cashier and Wallet stop re-fetching and stop
 * flashing a skeleton over a number that was already correct.
 *
 * The window is wrong for the opposite case. When BALANCE_UPDATED,
 * WALLET_REFRESHED, DIAMOND_BALANCE_CHANGED or DIAMOND_SPENT fires, something
 * has ALREADY moved the money; the value on screen is known to be wrong at that
 * instant. Left unguarded, those handlers called loadBalances() and the window
 * turned them into no-ops, so a real change could sit unshown for up to
 * BALANCE_FRESH_MS.
 *
 * That is strictly worse than the skeleton flash the window removed: a brief
 * flicker is cosmetic, a stale balance on a money surface is not. Every
 * event-driven and explicit-refresh path therefore passes { force: true }.
 *
 * Asserted at the source because the regression is "somebody adds a handler and
 * forgets force", which is a property of the code rather than of one call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceBlockAfter, sliceEnclosingBlock, sliceBetween, sliceCall } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const STORE = read('src/stores/useWalletStore.ts');
const HEADER = read('src/components/navigation/GlobalHeader.tsx');
const BUS = read('src/core/MasterBus.ts');
const WALLET_PAGE = read('src/pages/PlayerWalletPage.tsx');
const HOOKS = read('src/hooks/index.ts');

describe('the store still makes mounts free', () => {
  it('keeps the freshness window', () => {
    expect(STORE).toMatch(/BALANCE_FRESH_MS/);
  });

  it('accepts a force option that bypasses it', () => {
    expect(STORE).toMatch(/opts\?:\s*\{\s*force\?:\s*boolean\s*\}/);
    expect(STORE).toMatch(/!opts\?\.force/);
  });
});

describe('event-driven refreshes force past the window', () => {
  it('GlobalHeader forces on WALLET_REFRESHED', () => {
    const at = HEADER.indexOf("'WALLET_REFRESHED'");
    expect(at).toBeGreaterThan(-1);
    expect(sliceEnclosingBlock(HEADER, "'WALLET_REFRESHED'")).toMatch(/loadBalances\([^)]*\{\s*force:\s*true\s*\}\)/);
  });

  it('GlobalHeader forces on BALANCE_UPDATED', () => {
    const at = HEADER.indexOf("'BALANCE_UPDATED'");
    expect(at).toBeGreaterThan(-1);
    expect(sliceEnclosingBlock(HEADER, "'BALANCE_UPDATED'")).toMatch(/loadDiamonds\([^)]*\{\s*force:\s*true\s*\}\)/);
  });

  it('MasterBus forces on DIAMOND_BALANCE_CHANGED and DIAMOND_SPENT', () => {
    for (const event of ["'DIAMOND_BALANCE_CHANGED'", "'DIAMOND_SPENT'"]) {
      const at = BUS.indexOf(`this.subscribe(${event}`);
      expect(at, `${event} subscriber not found`).toBeGreaterThan(-1);
      expect(sliceEnclosingBlock(BUS, `this.subscribe(${event}`)).toMatch(/loadDiamonds\([^)]*\{\s*force:\s*true\s*\}\)/);
    }
  });

  it('PlayerWalletPage forces on every bus listener and on tab-return', () => {
    // Its bus block reloads on BALANCE_UPDATED / WALLET_REFRESHED / CHIPS_ADDED
    // / CHIPS_WITHDRAWN, and useVisibilityRefresh fires after the tab was
    // hidden - by definition a moment when the cached number may be old.
    const busAt = WALLET_PAGE.indexOf('// ── Bus Listeners ──');
    expect(busAt).toBeGreaterThan(-1);
    const busBlock = sliceBetween(
      WALLET_PAGE,
      '// ── Bus Listeners ──',
      '// ── Keyboard navigation'
    );
    const unforced = busBlock.match(/load(?:Balances|Diamonds)\(user\.id\)(?!\s*,)/g) || [];
    expect(unforced, 'unforced refresh inside a bus listener').toEqual([]);

    const visAt = WALLET_PAGE.indexOf('useVisibilityRefresh(');
    expect(visAt).toBeGreaterThan(-1);
    expect(sliceCall(WALLET_PAGE, 'useVisibilityRefresh(')).toMatch(
      /loadBalances\([^)]*\{\s*force:\s*true\s*\}\)/
    );
  });

  it('useWallet().refresh() forces - it is the explicit "this is stale" API', () => {
    // hooks/index.ts holds FOUR different `refresh: () =>` properties (union,
    // wallet, settlement, nearby). Anchor on the wallet one by finding the
    // refresh that actually calls loadBalances, rather than the first match.
    const candidates = [...HOOKS.matchAll(/refresh: \(\) => \{/g)].map((m) => m.index ?? -1);
    const walletRefresh = candidates
      .map((i) => sliceBlockAfter(HOOKS.slice(i), 'refresh: () => {'))
      .find((block) => /loadBalances\(/.test(block));
    expect(walletRefresh, 'no refresh() calling loadBalances found').toBeDefined();
    expect(walletRefresh!).toMatch(/loadBalances\([^)]*\{\s*force:\s*true\s*\}\)/);
  });
});

describe('mount paths deliberately do NOT force', () => {
  it('GlobalHeader mount effect stays guarded', () => {
    // This is the whole point of the window: arriving on a page is not evidence
    // that anything changed. If this ever gains force:true, every navigation
    // starts re-fetching again and the always-on work is undone.
    const at = HEADER.indexOf('loadOnce(authUser.id);');
    expect(at).toBeGreaterThan(-1);
    const mountBlock = sliceEnclosingBlock(HEADER, 'loadOnce(authUser.id);');
    expect(mountBlock).toMatch(/loadBalances\(authUser\.id\);/);
    expect(mountBlock).not.toMatch(/force:\s*true/);
  });
});
