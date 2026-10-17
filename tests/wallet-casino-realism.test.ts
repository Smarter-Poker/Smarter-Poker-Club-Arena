import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/PlayerWalletPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/pages/PlayerWalletPage.css'), 'utf8');
const LEDGER = readFileSync(resolve(ROOT, 'src/hooks/useDiamondLedger.ts'), 'utf8');
/* Phase 7: the paged tail both diamond panes render. The Load Older control
   and the failed-page retry moved OUT of the page and into here, so the pins
   below read this file for the control and the page only for its copy. */
const MORE = readFileSync(resolve(ROOT, 'src/components/wallet/DiamondLedgerMore.tsx'), 'utf8');
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
describe('the wallet opens on the Cashier desk (Dan 2026-10-16)', () => {
  it('ships a purpose-built, web-sized vault render through the media base', () => {
    expect(existsSync(HERO)).toBe(true);
    expect(statSync(HERO).size).toBeLessThan(150_000);
    expect(PAGE).toContain("mediaUrl('images/wallet/value-vault-hero-v1.webp')");
    expect(PAGE).toContain('fetchPriority="high"');
  });

  it('gives each wallet row the emblem cut from its own approved plate', () => {
    // Dan 2026-10-16: the wallet opens on the Cashier desk. The emblems are
    // derived from the approved square plates, never drawn.
    for (const name of ['diamonds', 'player', 'promo', 'agent']) {
      const file = resolve(
        ROOT,
        `public/assets/club-buttons/wallets/emblems/wallet-emblem-${name}-v1.webp`
      );
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size).toBeLessThan(40_000);
      expect(PAGE).toContain(`wallet-emblem-${name}-v1.webp`);
    }
    expect(PAGE).toContain('fmtNum(animatedAvail)');
    expect(PAGE).toContain('All Wallets Combined');
    expect(PAGE).toContain('Playable Now');
  });

  it('is printed on the Cashier desk: its inks, its dock art, no drawn chrome', () => {
    expect(CSS).toContain('THE CASHIER DESK');
    expect(CSS).toContain('--ink-muted: #9aa5b3');
    expect(CSS).toContain('--ink-blue: #45adff');
    expect(CSS).toContain('cashier-action-dock-v1.png');
    expect(CSS).toContain('cashier-action-dock-tall-v1.png');
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/linear-gradient/);
    // A declaration that draws a corner, judged on its VALUE (a bare
    // lookahead after \s* backtracks to zero width and matches `0`).
    expect(code).not.toMatch(/border-radius:\s*[1-9]/);
    expect(code).not.toMatch(/:hover/);
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(PAGE).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
  });

  it('opens on the routed Cashier workspace', () => {
    expect(PAGE).toContain('<CashierWorkspace compact eyebrow="Secure Wallet" title="Wallet">');
    expect(PAGE).not.toContain('RewardsSurfaceHeader');
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
    /* The floor is ONE diamond: send_wallet_diamond_transfer refuses only
       p_amount <= 0 (read on production 2026-09-13). The 10 this pinned was
       an invention that refused sends the platform allows. */
    expect(PAGE).toContain('MIN_DIAMOND_SEND = 1;');
    expect(PAGE).not.toContain('MIN_DIAMOND_SEND = 10');
    /* And the route REFUSES a request with no X-Idempotency-Key, so the send
       carries one, minted per intent and kept across a retry. */
    expect(PAGE).toContain('idempotencyKey: requestId');
    expect(PAGE).toContain('expectedUserId: user.id');
    expect(PAGE).toContain('const intentScope = `${user.id}:${recipientId}:${amount}`;');
    expect(PAGE).toContain('sendRequests.current.get(intentScope) ?? uuid()');
    expect(PAGE).toContain('if (e?.definitive) sendRequests.current.delete(intentScope);');
  });

  it('routes chip operations to the club cashier without a global-pool transfer', () => {
    expect(PAGE).toContain('Open Club Cashier');
    expect(PAGE).toContain("currentClubId ? `/clubs/${currentClubId}/cashier` : '/cashier'");
    expect(PAGE).not.toContain('internalTransfer');
  });

  it('receives: player id, profile link and every credit in the diamond ledger', () => {
    expect(PAGE).toContain('navigator.clipboard.writeText(text)');
    // The read moved into useDiamondLedger on 2026-09-05 (see the pagination
    // suite below); the pin moved with it rather than being dropped.
    expect(LEDGER).toContain(".from('diamond_transactions')");
    expect(LEDGER).toContain(".gt('amount', 0)");
    // `metadata` carries the other player's id (recipient_id / sender_id),
    // which the page resolves to a name through the friend list (2026-09-13).
    // Pinned as the column LIST, not as `select('...')` on one line: with
    // `player_line` in it (phase 6) the call is over the print width, so the
    // formatter wraps the argument onto its own line and a pin that spelled
    // out `select(` would fail on correctly formatted code.
    expect(LEDGER).toContain('.select(');
    // `description` left this list on 2026-09-30: nothing had read it since
    // phase 6 moved the copy to `player_line`, so it was an unread column on a
    // money query. See tests/the-ledger-speaks-to-the-player.law.test.ts.
    expect(LEDGER).toContain(
      "'id, type, transaction_type, amount, player_line, created_at, metadata'"
    );
    expect(PAGE).toContain("useDiamondLedger(user?.id, 'in', isMounted)");
  });

  it('earns: the daily login claim and the rewards progress read', () => {
    expect(PAGE).toContain("'/api/rewards/daily-login'");
    expect(PAGE).toContain("'/api/rewards/progress'");
    expect(PAGE).toContain('DiamondService.getLifetimeStats(user.id)');
    // Discovery links describe the destination, not an unbacked universal payout.
    expect(PAGE).toContain('Milestones, Badges, And Unlock Progress');
    expect(PAGE).toContain('Membership And Included Benefits');
    expect(PAGE).not.toContain('Milestones That Pay Out When You Hit Them');
    expect(PAGE).not.toContain('Daily And Monthly Diamond Bonuses For Members');
    expect(PAGE).not.toContain('VIP Bonuses');
    expect(PAGE).toContain("navigate('/achievements')");
    expect(PAGE).toContain("navigate('/vip')");
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

describe('the ledger has no floor, and a send leaves a record', () => {
  /*
   * Dan, 2026-09-05, on the two remaining wallet gaps: "1, GO AHEAD AND DO
   * THIS ... 3, GO AHEAD AND BUILD THIS."
   *
   * 1 was the Receive pane's hard `.limit(25)`: it read the newest 25 credits,
   * stopped, and said nothing about stopping. Measured on production the day
   * it was fixed - 645 players hold diamond credits, 6 hold more than 25, and
   * the longest ledger is 390. That player could reach 25 of their 390.
   *
   * 3 was the Send pane: a completed transfer left no trace a player could go
   * back to. The toast expires, Receive filters to credits (`amount > 0`), and
   * the Ledger tab reads the CHIP tables - so a sent diamond appeared on no
   * surface in this wallet at all.
   */

  it('pages the ledger instead of capping it', () => {
    /* Against the CODE, not the file: the doc comment names `.limit(25)` in
       the course of explaining why it is gone, and a bare toContain on the
       whole file matches that sentence and passes whatever the code does.
       That is the same false positive the route gate produced on comment
       prose, so it gets the same answer - blank the comments first. */
    const code = LEDGER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('.limit(');
    expect(LEDGER).toContain('.range(from, from + DIAMOND_LEDGER_PAGE - 1)');
    // A short page is the end. The button is offered only while it is not.
    expect(LEDGER).toContain('setHasMore(page.length === DIAMOND_LEDGER_PAGE)');
    expect(PAGE).toContain('Load Older Diamonds');
    expect(PAGE).toContain('Load Older Sends');
    /* Both panes get the tail from ONE component, so neither can drift, and
       the control inside it is a real button rather than a prop string. */
    expect(PAGE.match(/<DiamondLedgerMore\b/g)).toHaveLength(2);
    expect(MORE).toContain("{loadingMore ? 'Loading...' : moreLabel}");
  });

  it('starts the next page before the player reaches the bottom, without walking the table', () => {
    /* Phase 7. An IntersectionObserver sentinel at the foot of the list asks
       for the next page a screenful early. The runway is the whole guard
       against a chain of .range() calls: it must stay well under the height
       of one landed page, or every page re-arms the sentinel. Behaviour, so
       the depth is in tests/unit/theLedgerFetchesBeforeYouAsk.test.tsx. */
    expect(MORE).toContain('new IntersectionObserver(');
    expect(MORE).toContain('rootMargin: `0px 0px ${LEDGER_PREFETCH_RUNWAY_PX}px 0px`');
    const runway = Number(/LEDGER_PREFETCH_RUNWAY_PX = (\d+)/.exec(MORE)?.[1]);
    expect(runway).toBeGreaterThan(0);
    expect(runway).toBeLessThan(1000);
    // One page at a time, latched on a ref because the prop is still stale.
    expect(MORE).toContain('if (firedRef.current || loadingRef.current) return;');
    // No leaked observers: the sentinel unmounts, and so does its observer.
    expect(MORE).toContain('observerRef.current.disconnect();');
    // The sentinel is decoration. The button is the affordance, and it stays.
    expect(MORE).toContain('aria-hidden="true"');
    expect(CSS).toContain('.ledger-prefetch-sentinel');
  });

  it('orders by a UNIQUE key, or a page seam serves one row twice and skips another', () => {
    // Not defensive: production holds 8 groups of credits written at an
    // identical created_at, the largest 29 rows - bigger than a whole page.
    // `id` is a uuid in a unique index, so it makes the ordering total.
    expect(LEDGER).toMatch(
      /\.order\('created_at', \{ ascending: false \}\)\s*\n?\s*\.order\('id', \{ ascending: false \}\)/
    );
  });

  it('continues from the rows on screen, never from a page counter', () => {
    // `refresh` prepends arriving rows, so the Nth page stops beginning at
    // N * pageSize and a counter re-serves a row that has shifted down.
    expect(LEDGER).toContain("const from = mode === 'more' ? rowsRef.current.length : 0");
  });

  it('a refresh MERGES, so an arriving diamond cannot collapse a paged list', () => {
    // Re-reading as a reset would drop a player who had paged to 100 rows back
    // to 25 the moment a credit landed - worse than the cap it replaces.
    expect(LEDGER).toContain(
      "const merged = mode === 'refresh' ? [...fresh, ...base] : [...base, ...fresh]"
    );
    // And it must not re-offer Load More to someone already holding every row.
    expect(LEDGER).toContain("if (mode !== 'refresh') setHasMore(");
    expect(PAGE).toContain("void loadIncoming('refresh')");
  });

  it('a failed LATER page keeps the pages already read', () => {
    expect(LEDGER).toMatch(
      /if \(mode === 'reset'\) \{\s*rowsRef\.current = \[\];\s*setRows\(\[\]\)/
    );
    expect(PAGE).toContain('Could Not Load Older Diamonds');
    expect(PAGE).toContain('Could Not Load Older Sends');
    /* And the retry is a control the player presses, not another observer
       pass: a prefetch that failed disarms the sentinel (`armed`). */
    expect(MORE).toContain('const armed = hasMore && !error;');
    expect(MORE).toContain('Retry');
  });

  it('the send side is read by KIND, because a refund of a gift is positive', () => {
    // `amount < 0` would hide diamond_gift_refund, which is the one row a
    // sender most needs to see: the transfer failed and their diamonds came
    // back. The kinds are read from the transfer route, not guessed.
    expect(LEDGER).toContain(
      "const SENT_KINDS = ['diamond_gift_sent', 'live_gift_sent', 'diamond_gift_refund']"
    );
    expect(LEDGER).toContain('transaction_type.in.(${list}),type.in.(${list})');
    expect(PAGE).toContain("useDiamondLedger(user?.id, 'out', isMounted)");
  });

  it('a completed send refreshes its own record', () => {
    // The whole of gap 3 in one assertion: the transfer succeeded, so the
    // record of it appears without the player reloading anything.
    const sendHandler = sliceBetween(PAGE, "'/api/store/diamond-transfer'", 'catch (err)');
    expect(sendHandler).toContain("void loadSent('refresh')");
  });

  it('renders the sign from the ROW, so a refund is not drawn as an outgoing', () => {
    expect(PAGE).toContain("{row.amount < 0 ? '-' : '+'}");
    expect(PAGE).toContain('fmtNum(Math.abs(row.amount))');
    expect(CSS).toContain('.incoming-row__amount.is-outgoing');
  });
});

describe('the balance sits where the Cashier puts a balance', () => {
  /*
   * Dan, 2026-10-16: "balances aren't centered or font sized correctly inside
   * their frames". The plates printed into a painted bay the figure never fit.
   * The desk has no bay to miss: the page balance is one centred figure, and
   * each wallet's balance is the right-aligned figure of its row, as the
   * Cashier prints a player's chips.
   */
  const rule = (selector: string) => {
    const start = CSS.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(-1);
    return CSS.slice(start, CSS.indexOf('}', start));
  };

  it('centres the page balance and its figures', () => {
    expect(rule('.wallet-balance')).toContain('align-items: center;');
    expect(rule('.wallet-balance')).toContain('text-align: center;');
    expect(rule('.wallet-balance__meta')).toContain('justify-content: center;');
  });

  it('right-aligns each wallet balance in its row, never wider than the row', () => {
    expect(rule('.wallet-row__figure')).toContain('align-items: flex-end;');
    expect(rule('.wallet-row__figure')).toContain('text-align: right;');
    // A money figure is never cut with an ellipsis; it shrinks to fit.
    expect(rule('.wallet-row__value')).not.toContain('text-overflow');
    expect(rule('.wallet-row__value')).not.toContain('overflow: hidden');
    expect(rule('.wallet-row__value')).toMatch(/font-size: clamp\([^)]*cqw/);
  });

  it('prints the figure INSIDE the row, beside its name', () => {
    expect(PAGE.indexOf('wallet-row__figure')).toBeGreaterThan(PAGE.indexOf('wallet-row__main'));
  });

  it('still announces every figure', () => {
    expect(PAGE).toMatch(
      /aria-label=\{`\$\{config\.label\} Wallet:[^`]*Available[^`]*Locked[^`]*Total/s
    );
  });
});

describe('the header wallet button opens the wallet', () => {
  it('navigates to /wallet, not the diamond store tab', () => {
    // Dan 2026-09-04: "when you click the wallet from the global header it
    // takes you to marketplace. It's supposed to take you to the wallet."
    // The wallet button element: from its class token to its closing tag.
    const walletBtn = sliceBetween(HEADER, 'styles.walletBtn', '</button>');
    // It still opens the wallet; since 2026-09-07 it carries the club the
    // page is inside so the wallet opens on that club (the-menu-stays-in-the-club).
    expect(walletBtn).toContain("navigate(withClubContext('/wallet', routeClubId))");
    expect(walletBtn).not.toContain('marketplace?tab=diamonds');
  });
});

describe('diamond purchases: the errors a lifetime member and a retrying buyer used to get', () => {
  it('a lifetime VIP is not sold a pass the server will refuse', () => {
    expect(MEMBERSHIP).toContain("wallet.vipTier === 'lifetime'");
    expect(MEMBERSHIP).toContain('Included With Lifetime VIP');
    expect(MEMBERSHIP).toMatch(/if \(isLifetime\) \{\s*toast\.info\(/);
  });

  it('a definitive refusal retires only its exact protected purchase key', () => {
    expect(STORE).toContain('const definitiveRefusal = apiError.definitive === true;');
    expect(STORE).toContain('if (definitiveRefusal) {');
    expect(STORE).toContain(
      'clearSessionPurchaseRequestIfMatches(purchaseScope, purchaseIntent.requestId)'
    );
    expect(STORE).not.toContain('purchaseKeyRef.current = mintPurchaseKey()');
  });

  it('the marketplace opens the club that actually has stock, not the first membership row', () => {
    expect(MARKET).not.toMatch(
      /from\('club_members'\)[\s\S]{0,120}\.limit\(1\)\s*\.maybeSingle\(\)/
    );
    expect(MARKET).toContain(".from('club_shop_items')");
    expect(MARKET).toContain('useUserStore.getState().currentClubId');
  });
});
