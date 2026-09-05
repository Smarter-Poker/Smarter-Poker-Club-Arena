import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/PlayerWalletPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/pages/PlayerWalletPage.css'), 'utf8');
const HEADER = readFileSync(resolve(ROOT, 'src/components/navigation/GlobalHeader.tsx'), 'utf8');
const MEMBERSHIP = readFileSync(resolve(ROOT, 'src/pages/marketplace/MembershipTab.tsx'), 'utf8');
const STORE = readFileSync(resolve(ROOT, 'src/pages/marketplace/StoreTab.tsx'), 'utf8');
const MARKET = readFileSync(resolve(ROOT, 'src/pages/MarketplacePage.tsx'), 'utf8');
const HERO = resolve(ROOT, 'public/images/wallet/value-vault-hero-v1.webp');

/*
 * Dan 2026-09-04: "this entire wallet page needs a full audit, enhancement,
 * improvement, bug hunt and optimization ... add the #SMARTERCASINOREALISM
 * ... make sure that wallets can send and receive, as well as earn."
 */
describe('the wallet is a rendered vault room, not a generic dark dashboard', () => {
  it('ships a purpose-built, web-sized vault render through the media base', () => {
    expect(existsSync(HERO)).toBe(true);
    expect(statSync(HERO).size).toBeLessThan(150_000);
    expect(PAGE).toContain("mediaUrl('images/wallet/value-vault-hero-v1.webp')");
    expect(PAGE).toContain('fetchPriority="high"');
  });

  it('lays live ledger figures into the rendered wallet plates', () => {
    expect(PAGE).toContain('wallet-diamonds-square-v1.webp');
    expect(PAGE).toContain('wallet-player-wallet-square-v1.webp');
    expect(PAGE).toContain('wallet-promo-wallet-square-v1.webp');
    expect(PAGE).toContain('wallet-agent-wallet-square-v1.webp');
    expect(PAGE).toContain('fmtNum(animatedAvail)');
    expect(PAGE).toContain('All Wallets Combined');
    expect(PAGE).toContain('Playable Now');
  });

  it('uses the wallet visual system and respects reduced motion', () => {
    expect(CSS).toContain('#SMARTERCASINOREALISM');
    expect(CSS).toContain('--vault-cyan: #00d4ff');
    expect(CSS).toContain("'Rajdhani'");
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(PAGE).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('keeps the Rewards Circuit anchor the route family test pins', () => {
    expect(PAGE).toContain('RewardsSurfaceHeader');
  });
});

describe('wallets can send, receive and earn - wired to the real doors', () => {
  it('sends diamonds to an accepted friend through the World Hub transfer route', () => {
    expect(PAGE).toContain('storeFetch<');
    expect(PAGE).toContain("'/api/store/diamond-transfer'");
    expect(PAGE).toContain('body: { recipientId, amount }');
    // Friends only: the picker is the friend list, both directions.
    expect(PAGE).toContain(".from('friendships')");
    expect(PAGE).toContain(".eq('status', 'accepted')");
    expect(PAGE).toContain('MIN_DIAMOND_SEND = 10');
  });

  it("moves chips between the player's own wallets through the store", () => {
    expect(PAGE).toContain('internalTransfer(user.id, transferFrom, transferTo, amount)');
    expect(PAGE).toMatch(/if \(!transferred\)/);
  });

  it('receives: player id, profile link and every credit in the diamond ledger', () => {
    expect(PAGE).toContain('navigator.clipboard.writeText(text)');
    expect(PAGE).toContain(".from('diamond_transactions')");
    expect(PAGE).toContain(".gt('amount', 0)");
    expect(PAGE).toContain("select('id, type, transaction_type, amount, description, created_at')");
  });

  it('earns: the daily login claim and the rewards progress read', () => {
    expect(PAGE).toContain("'/api/rewards/daily-login'");
    expect(PAGE).toContain("'/api/rewards/progress'");
    expect(PAGE).toContain('DiamondService.getLifetimeStats(user.id)');
  });

  it('Add Chips and Cash Out go to the club cashier when a club is in context', () => {
    expect(PAGE).toMatch(/navigate\(`\/clubs\/\$\{currentClubId\}\/cashier`\)/);
  });

  it('keeps a keyboard-operable tablist with five panes', () => {
    expect(PAGE).toContain("['overview', 'send', 'receive', 'earn', 'history']");
    expect(PAGE).toContain("['ArrowRight', 'ArrowLeft', 'Home', 'End']");
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('role="tabpanel"');
  });
});

describe('one sub-read must not zero the whole wallet', () => {
  const SERVICE = readFileSync(resolve(ROOT, 'src/services/WalletService.ts'), 'utf8');

  it('reads every agents row, because an agent is an agent per club', () => {
    // `agents` is UNIQUE on (club_id, user_id). `.maybeSingle()` answered
    // PGRST116 "Results contain 2 rows" for anyone agenting two clubs, the
    // throw below aborted the whole read, and Playable Now / All Wallets /
    // Player / Promo / Business all rendered 0 over real money. 16 users on
    // production, Dan among them (1,000,744.97 chips reading as zero).
    const agentsRead = sliceBetween(SERVICE, "from('agents')", '),');
    expect(agentsRead).not.toContain('maybeSingle');
    expect(agentsRead).not.toContain('.single(');
  });

  it('sums the agent wallets rather than picking one', () => {
    // Business is "Commissions And Settlements" - the sum across the clubs the
    // player agents for, exactly as PLAYER sums their club memberships.
    expect(SERVICE).toContain('const businessTotal = (agentRes.data || []).reduce(');
    expect(SERVICE).toContain('num(r.agent_wallet_balance)');
  });
});

describe('the header wallet button opens the wallet', () => {
  it('navigates to /wallet, not the diamond store tab', () => {
    // Dan 2026-09-04: "when you click the wallet from the global header it
    // takes you to marketplace. It's supposed to take you to the wallet."
    // The wallet button element: from its class token to its closing tag.
    const walletBtn = sliceBetween(HEADER, 'styles.walletBtn', '</button>');
    expect(walletBtn).toContain("navigate('/wallet')");
    expect(walletBtn).not.toContain('marketplace?tab=diamonds');
  });
});

describe('diamond purchases: the errors a lifetime member and a retrying buyer used to get', () => {
  it('a lifetime VIP is not sold a pass the server will refuse', () => {
    expect(MEMBERSHIP).toContain("wallet.vipTier === 'lifetime'");
    expect(MEMBERSHIP).toContain('Included With Lifetime VIP');
    expect(MEMBERSHIP).toMatch(/if \(isLifetime\) \{\s*toast\.info\(/);
  });

  it('a refused purchase does not replay under the same idempotency key', () => {
    const catchBlock = STORE.slice(
      STORE.indexOf("toast.error(err instanceof Error ? err.message : 'Purchase failed')")
    );
    expect(catchBlock).toContain('purchaseKeyRef.current = mintPurchaseKey()');
  });

  it('the marketplace opens the club that actually has stock, not the first membership row', () => {
    expect(MARKET).not.toMatch(
      /from\('club_members'\)[\s\S]{0,120}\.limit\(1\)\s*\.maybeSingle\(\)/
    );
    expect(MARKET).toContain(".from('club_shop_items')");
    expect(MARKET).toContain('useUserStore.getState().currentClubId');
  });
});
