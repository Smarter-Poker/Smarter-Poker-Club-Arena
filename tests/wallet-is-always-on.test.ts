/**
 * THE WALLET MUST NOT RELOAD OR RE-SYNC WHEN YOU CHANGE PAGES.
 *
 * Dan, 2026-08-24, top priority: "I NEVER WANT ANY WALLETS, TABLES, OR ANYTHING
 * TO HAVE TO 'RELOAD' OR 'RE SYNC' ANY TIME YOU CHANGE PAGES OR ANYTHING ELSE."
 *
 * Four separate things conspired to break that, each fixed and each pinned here:
 *
 *  1. `useWalletStore.loadBalances` flipped `isLoadingWallet: true` and refetched
 *     on EVERY call. GlobalHeader, PlayerWalletPage and CashierPage all call it
 *     on mount, so every navigation between them re-fetched and flashed a
 *     skeleton over a balance that was already correct.
 *  2. `partialize: () => ({})` persisted NOTHING, so every hard reload, PWA cold
 *     start and iOS tab reclaim put the wallet back to 0.
 *  3. `loadDiamonds`'s catch did `set({ diamonds: 0 })`, so a transient network
 *     failure replaced a good number with zero - which reads as "your diamonds
 *     are gone" rather than "we could not check".
 *  4. The only live `wallets` subscription was mounted on two pages, so a
 *     balance changed server-side (agent transfer, admin credit, rakeback) never
 *     reached a player sitting anywhere else.
 *
 * These are asserted against the source rather than by driving the store,
 * because the regression being guarded is "somebody reinstates the old
 * behaviour" - a property of the code, not of one call's return value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceBlockAfter, sliceEnclosingBlock } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

/**
 * Strip comments before asserting that a pattern is ABSENT.
 *
 * Without this, an assertion like "the source must not contain
 * `set({ diamonds: 0 })`" matches the comment that documents having REMOVED
 * `set({ diamonds: 0 })` — so the better the explanation, the redder the test.
 * Absence assertions have to look at code; presence assertions are fine either
 * way and deliberately still run against the full text.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const STORE = read('src/stores/useWalletStore.ts');
const SYNC_HOOKS = read('src/services/PostgresSyncHooks.ts');
const CLUB_HOME = read('src/pages/ClubHomePage.tsx');
const HEADER_STORE = read('src/stores/useHeaderDataStore.ts');

describe('wallet store serves cached balances instead of refetching', () => {
  it('has a freshness window', () => {
    expect(STORE).toMatch(/BALANCE_FRESH_MS/);
  });

  it('short-circuits loadBalances when the cached balance is fresh for this user', () => {
    // The guard must key on BOTH the user and the timestamp: on time alone it
    // would serve the previous user's balance on a shared device.
    expect(STORE).toMatch(/_balancesUserId === userId/);
    expect(STORE).toMatch(/Date\.now\(\) - st\._balancesAt < BALANCE_FRESH_MS/);
  });

  it('keeps a force escape hatch for paths that must re-read', () => {
    expect(STORE).toMatch(/opts\?:\s*\{\s*force\?:\s*boolean\s*\}/);
  });

  it('does not raise the loading flag when a balance is already on screen', () => {
    // `set({ isLoadingWallet: true })` unconditionally at the top of
    // loadBalances is what produced the skeleton flash.
    expect(STORE).toMatch(/haveBalancesForThisUser/);
  });
});

describe('wallet survives a reload without going to zero', () => {
  it('persists balances rather than persisting nothing', () => {
    // codeOnly for the same reason: the block comment above partialize quotes
    // the old `() => ({})` form while explaining why it changed.
    expect(codeOnly(STORE)).not.toMatch(/partialize:\s*\(\)\s*=>\s*\(\{\}\)/);
    expect(STORE).toMatch(/partialize:\s*\(state\)\s*=>/);
    expect(STORE).toMatch(/balances:\s*state\.balances/);
  });

  it('persists the owning user id, so a shared device cannot bleed', () => {
    expect(STORE).toMatch(/_balancesUserId:\s*state\._balancesUserId/);
  });

  it('never persists the transaction ledger', () => {
    // Large and genuinely sensitive, and no surface needs it on boot.
    const partialize = sliceBlockAfter(STORE, 'partialize: (state)');
    expect(partialize).not.toMatch(/transactions:/);
  });
});

describe('a failed fetch never destroys a good balance', () => {
  it('does not zero diamonds in the catch path', () => {
    // codeOnly: the comment recording the removal quotes the old line verbatim.
    expect(codeOnly(STORE)).not.toMatch(/set\(\{\s*diamonds:\s*0\s*\}\)/);
  });
});

describe('balance changes reach the player on every page', () => {
  it('subscribes to wallets globally in PostgresSyncHooks', () => {
    expect(SYNC_HOOKS).toMatch(/table:\s*'wallets'/);
  });

  it('scopes that subscription to the user, not the whole table', () => {
    // The 2026-04 billing incident was UNFILTERED table-wide listeners. A
    // filtered one is cheap; an unfiltered one must never come back.
    const at = SYNC_HOOKS.indexOf("table: 'wallets'");
    const walletsBlock = sliceEnclosingBlock(SYNC_HOOKS, "table: 'wallets'");
    expect(walletsBlock).toMatch(/filter:\s*`user_id=eq\.\$\{userId\}`/);
  });

  it('emits BALANCE_UPDATED so the debounced global sync refetches once', () => {
    expect(SYNC_HOOKS).toMatch(/'wallet_balance',\s*'BALANCE_UPDATED'/);
  });
});

describe('the wallets listener is global, not page-scoped', () => {
  const WALLET_PAGE = read('src/pages/PlayerWalletPage.tsx');

  it('PlayerWalletPage no longer owns a user-wallet channel', () => {
    // Page-scoped, so leaving /wallet tore it down and returning re-negotiated
    // it - and because it was the ONLY wallets listener, every other page had
    // no live balance at all. It now lives in PostgresSyncHooks.
    expect(codeOnly(WALLET_PAGE)).not.toMatch(/getOrCreateChannel\(\s*`user-wallet-/);
    expect(codeOnly(WALLET_PAGE)).not.toMatch(/removeRegisteredChannel\(\s*`user-wallet-/);
  });

  it('PlayerWalletPage does not subscribe to the wallets table itself', () => {
    expect(codeOnly(WALLET_PAGE)).not.toMatch(/table:\s*'wallets'/);
  });
});

describe('club membership changes are handled globally, not per page', () => {
  const HOME = read('src/pages/HomePage.tsx');

  it('HomePage no longer owns a home-clubs channel', () => {
    // Duplicate of the club_members listener already in PostgresSyncHooks'
    // global channel, AND torn down on every navigation away from Home.
    expect(codeOnly(HOME)).not.toMatch(/getOrCreateChannel\(\s*channelKey\s*\)/);
    expect(codeOnly(HOME)).not.toMatch(/home-clubs-/);
  });

  it('HomePage still reacts to the bus events the global listener emits', () => {
    // This is what makes removing the channel safe: the refresh path is
    // unchanged, only the duplicate socket subscription is gone.
    expect(HOME).toMatch(/'CLUB_JOINED'/);
    expect(HOME).toMatch(/'CLUB_LEFT'/);
    expect(HOME).toMatch(/'CLUB_UPDATED'/);
  });

  it('the global listener still emits those events', () => {
    expect(SYNC_HOOKS).toMatch(/table:\s*'club_members'/);
    expect(SYNC_HOOKS).toMatch(/'CLUB_UPDATED'/);
    expect(SYNC_HOOKS).toMatch(/'CLUB_LEFT'/);
  });
});

describe('the club lobby paints from cache with no skeleton frame', () => {
  it('seeds club and tables during render, not in an effect', () => {
    // An effect runs AFTER paint, so restoring the cache there guaranteed one
    // frame of skeleton on every club entry - the flicker that reads as "the
    // lobby reloads every time".
    expect(CLUB_HOME).toMatch(/const bootCache = useState\(\(\) =>/);
    expect(CLUB_HOME).toMatch(/useState<ClubData \| null>\(bootCache\?\.club \?\? null\)/);
  });

  it('does not start in the loading state when cached data exists', () => {
    expect(codeOnly(CLUB_HOME)).not.toMatch(/const \[loading, setLoading\] = useState\(true\)/);
    expect(CLUB_HOME).toMatch(/useState\(!bootCache\?\.club\)/);
  });

  it('seeds hasDataRef to agree with what is painted', () => {
    // Otherwise the stall watchdog can declare a stall over a lobby the player
    // is actually looking at.
    expect(CLUB_HOME).toMatch(/useRef\(Boolean\(bootCache\?\.club\)\)/);
  });
});

/**
 * WHY THIS BLOCK EXISTS, AND WHY GlobalHeader WAS NOT RESTRUCTURED.
 *
 * HomePage renders its own <GlobalHeader /> and sits OUTSIDE
 * `<Route element={<AppLayout />}>`, which renders a second one. So navigating
 * Home <-> a club unmounts one header instance and mounts the other.
 *
 * The obvious "always-on" fix is to hoist the header above <Routes> so one
 * instance survives every navigation. That was assessed and deliberately NOT
 * done, because the benefit is now nil and the risk is real:
 *
 *   BENEFIT - a remount performs ZERO network requests. Every mount effect in
 *   GlobalHeader is a local listener (keyboard, edge-swipe, postMessage, a bus
 *   emit, a state reset) except one, which calls loadOnce + loadBalances +
 *   loadDiamonds - and all three are guarded, which is what this block pins.
 *   The only state lost is `menuOpen`, which should reset on navigation anyway.
 *
 *   RISK - the header is `position: sticky; top: 0` with `z-index: 130` tuned
 *   against HomePage's loading dim layer, and it carries the notch/safe-area
 *   padding. Its own CSS documents supporting TWO different parents
 *   (`align-self: stretch` for HomePage's centring flex column, `width: 100%`
 *   for AppLayout's block). Sticky resolves against the nearest scrolling
 *   ancestor, so hoisting it out of both changes its behaviour on every one of
 *   70+ routes. Moving HomePage under AppLayout instead would wrap a
 *   deliberately full-bleed page in `.main` and give it a second offline banner.
 *
 * That is a purely visual change across the whole app, and it cannot be proven
 * by a unit test - which is exactly why it was declined rather than shipped on
 * a "it compiles" basis.
 *
 * So the guards below are load-bearing: they are the reason the restructure is
 * unnecessary. If one is removed, the remount stops being free and the
 * trade-off has to be revisited.
 */
describe('a GlobalHeader remount costs no network (why the hoist is unnecessary)', () => {
  it('loadOnce is a no-op for a userId already loaded', () => {
    expect(HEADER_STORE).toMatch(/Subsequent calls with the same userId are no-ops/);
    expect(HEADER_STORE).toMatch(/loadOnce:\s*\(userId: string\)/);
  });

  it('loadBalances and loadDiamonds short-circuit on a fresh cached balance', () => {
    // Already asserted above, restated here because THIS is the property that
    // makes a header remount free. Losing it silently re-opens the question.
    expect(STORE).toMatch(/BALANCE_FRESH_MS/);
    expect(STORE).toMatch(/_balancesUserId === userId/);
  });
});

describe('entering a club does not wipe the wallet', () => {
  it('resets per-club state only on a real club change', () => {
    // useEffect(..., [clubId]) also fires on FIRST MOUNT, so the reset ran on
    // every entry and zeroed the wallet before the refetch that would fill it.
    expect(CLUB_HOME).toMatch(/prevClubIdRef/);
    expect(CLUB_HOME).toMatch(/if \(previous === undefined \|\| previous === clubId\) return;/);
  });
});
