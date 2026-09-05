/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CASHIER IS ROLE SCOPED, AND ITS CLOCK IS THE SERVER'S
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25, binding, verbatim:
 *
 *   "it needs to be role specific wallets. Owners, Co Owners, Admins and Super
 *    Agents can access the global bank, but they need to click on the global
 *    bank to send from the global bank. if they simply just click cashier, this
 *    must always be the default 1, Agent and player wallets only. Super Agents,
 *    Agents, and Sub Agents should ONLY EVER SEE there downlines, and there
 *    downline agents downlines here... nobody else. Owners, Co owners and
 *    Admins should see everyone. any chips sent or claimed back transact from
 *    the Agent Wallet. Agents can only claim back chips that were sent in the
 *    first 10 minutes (reconciling a mistake) after that, they can not remove
 *    chips from downline wallets unless there downline requests a cash out."
 *
 * Every clause below is one describe block. Where a clause can be expressed as a
 * function it is asserted as a function; where it is a wiring decision inside a
 * component with six realtime subscriptions attached, it is asserted against the
 * source text, because mounting that component to learn which RPC it calls costs
 * more than it proves.
 *
 * WHAT THESE WERE WRITTEN AGAINST — six defects found on 2026-08-25:
 *
 *  1. CashierPage read `ca_club_my_downline` as `{ scoped, user_ids }`. That RPC
 *     returns a TABLE of downline AGENTS - it has never had either field. Both
 *     came back undefined, so the recipient filter collapsed to `[user.id]` and
 *     every super agent, agent and sub agent opened Send to find exactly one
 *     recipient: themselves, which fn_agent_wallet_send then refuses as a
 *     self-send. The tab was unusable for the three roles it exists for.
 *
 *  2. CashierPage's Send moved the WRONG ACCOUNT. It checked
 *     balances.PLAYER.available (the global wallet) and called
 *     ChipFlowService.agentToPlayer, whose own doc comment says it sends "from
 *     their own PLAYER wallet" - not agents.agent_wallet_balance. No ledger row,
 *     no idempotency key, no downline check, and no result check either, so a
 *     refusal printed "Sent 500 chips".
 *
 *  3. Both Claim Back countdowns used the BROWSER CLOCK
 *     (`Date.now()` vs `reversible_until`) while `seconds_left` sat unread on
 *     every row. A phone ten minutes fast offered no claims at all.
 *
 *  4. The agent-to-agent destination coercion was applied to EVERY cashier, so
 *     the Club Bank could no longer fund a promo wallet.
 *
 *  5. The roster offered the viewer their own name on cashiers whose RPC refuses
 *     a self-send outright.
 *
 *  6. co_owner and admin had no Send tab, while every other rule on the page
 *     (recipient list, quick links, the RPC itself) already admitted them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  DEFAULT_CASHIER_WALLET,
  cashierTabs,
  cashierDestinations,
  canUseCashier,
  destinationBlurb,
  // coercesToAgentWallet is exercised in agent-to-agent-credits-the-agent-wallet.test.ts,
  // which owns that rule; importing it here only to not use it is noise.
  cashierRefusesSelfSend,
  secondsLeftFromServer,
} from '../src/components/wallet/cashierModes';
import { canSeeClubBank, canHoldAgentWallet } from '../src/components/wallet/walletRows';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const MODAL = read('src/components/wallet/WalletCashierModal.tsx');
const MODAL_CSS = read('src/components/wallet/WalletCashierModal.css');
const MINT = read('src/components/wallet/ChipMintModal.tsx');
const CLASSIC = read('src/pages/CashierPage.tsx');
const TRADE = read('src/pages/CashierTradePage.tsx');

const STAFF = ['owner', 'co_owner', 'admin'] as const;
const AGENTS = ['super_agent', 'agent', 'sub_agent'] as const;

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 1 — clicking Cashier never opens the global bank', () => {
  it('the default wallet is the agent wallet, for every role including an owner', () => {
    expect(DEFAULT_CASHIER_WALLET).toBe('agent_wallet');
  });

  it('every mount point falls back to that constant rather than spelling one out', () => {
    /**
     * Four pages each carried their own `activeCashier || 'club_bank'` and a
     * fifth would have copied it. The literal must not come back.
     */
    for (const src of [CLASSIC, TRADE]) {
      expect(src).toContain('walletType={activeCashier || DEFAULT_CASHIER_WALLET}');
      expect(src).not.toContain("activeCashier || 'club_bank'");
    }
  });

  it('the modal is only open when a wallet was deliberately chosen', () => {
    // isOpen is driven by activeCashier being non-null, so the fallback above
    // can never be the thing on screen - it only satisfies the prop type.
    for (const src of [CLASSIC, TRADE]) {
      expect(src).toContain('isOpen={!!activeCashier}');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 2 — the global bank needs a separate, role-gated click', () => {
  it('only owner, co owner, admin and super agent may stand at it', () => {
    for (const r of STAFF) expect(canUseCashier('club_bank', r)).toBe(true);
    expect(canUseCashier('club_bank', 'super_agent')).toBe(true);
    expect(canUseCashier('club_bank', 'agent')).toBe(false);
    expect(canUseCashier('club_bank', 'sub_agent')).toBe(false);
    expect(canUseCashier('club_bank', 'player')).toBe(false);
    // An unrecognised role normalises to player. Not seeing is the default.
    expect(canUseCashier('club_bank', 'gibberish')).toBe(false);
    expect(canUseCashier('club_bank', undefined)).toBe(false);
  });

  it('the agent and promo cashiers admit the people who hold those wallets', () => {
    for (const r of [...STAFF, ...AGENTS]) {
      expect(canUseCashier('agent_wallet', r)).toBe(true);
      expect(canUseCashier('promo_wallet', r)).toBe(true);
    }
    expect(canUseCashier('agent_wallet', 'player')).toBe(false);
  });

  it('the trade grid gates its Club Bank entry point on the same four roles', () => {
    expect(TRADE).toContain('canSeeClubBank(myRole) && (');
    expect(TRADE).toContain("setActiveCashier('club_bank')");
    for (const r of STAFF) expect(canSeeClubBank(r)).toBe(true);
    expect(canSeeClubBank('super_agent')).toBe(true);
    expect(canSeeClubBank('agent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 3 — agents see their downline and nobody else', () => {
  /**
   * fn_club_cashier_members is the ONE answer, and it is the same recursive
   * club_members.agent_id edge fn_club_cashier_can_transact refuses on. It
   * returns everyone for owner/co_owner/admin (scope 'all'), the recursive
   * downline for super_agent/agent/sub_agent (scope 'downline'), and nothing for
   * a plain player. Verified against production: fn_club_cashier_scope maps
   * exactly those roles to exactly those three answers.
   */
  it('all three cashier surfaces read the same downline RPC', () => {
    for (const src of [MODAL, CLASSIC]) {
      expect(src).toMatch(/supabase\s*\.rpc\(\s*'fn_club_cashier_members(?:_v2)?'/);
    }
    expect(TRADE).toContain("'fn_club_cashier_members_page_v3'");
  });

  it('the classic cashier no longer misreads ca_club_my_downline', () => {
    /**
     * The defect, precisely: `ca_club_my_downline` RETURNS TABLE(agent_id,
     * path, depth, username, full_name, avatar_url, total_members,
     * direct_members). This page cast the array to
     * `{ scoped?: boolean; user_ids?: string[] }` and read two fields that do
     * not exist, so `downlineIds` became [] and the roster became the viewer.
     */
    expect(CLASSIC).not.toContain("supabase.rpc('ca_club_my_downline'");
    // The two fields it read that the RPC has never had, and the array they
    // produced. Matched as code (`scope?.user_ids`, `.in('user_id', …)`) rather
    // than as words, so the post-mortem comment above the fix does not count.
    expect(CLASSIC).not.toContain('scope?.user_ids');
    expect(CLASSIC).not.toMatch(/let downlineIds/);
    expect(CLASSIC).not.toMatch(/query\.in\('user_id', effectiveDownline\)/);
  });

  it('a failed downline read is an error, never an empty club', () => {
    // Rendering "no recipients" over a dropped connection is how an agent
    // concludes their players have vanished.
    expect(CLASSIC).toContain('if (scopedErr) throw scopedErr');
  });

  it('staff keep the whole-club read, which is the same set scope all returns', () => {
    // A union owner with no club_members row would be handed nothing by the
    // RPC, so the paged read stays for the roles whose scope is already 'all'.
    expect(CLASSIC).toContain("const agentScoped = ['super_agent', 'agent', 'sub_agent']");
    expect(CLASSIC).toMatch(/if \(agentScoped\) \{/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 4 — owners, co owners and admins see everyone', () => {
  it('isClubStaff is what decides, so co_owner is never left behind', () => {
    // The bug this replaces: canSend listed 'owner' and the three agent roles
    // by hand. co_owner and admin got a recipient list, a funded agent wallet
    // and a server that accepts their send - and no Send tab to do it from.
    expect(CLASSIC).toContain(
      'const canSend = isClubStaff(userRole) || isAgentRole(userRole) || isUnionOwner;'
    );
    expect(CLASSIC).not.toMatch(
      /userRole === 'owner' \|\|\s*isUnionOwner \|\|\s*userRole === 'agent'/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 5 — sends and claim backs move the AGENT wallet', () => {
  it('all three surfaces use the agent-wallet send path', () => {
    for (const src of [MODAL, CLASSIC]) {
      expect(src).toContain("supabase.rpc('fn_agent_wallet_send'");
    }
    // The trade grid batches network round trips; the batch RPC delegates each
    // item to fn_agent_wallet_send and is pinned by cashier-phase3-performance.
    expect(TRADE).toContain("supabase.rpc('fn_cashier_batch_transfer'");
  });

  it('the classic cashier no longer routes a send through the player wallet', () => {
    /**
     * ChipFlowService.agentToPlayer debits the agent's own PLAYER wallet (its
     * own comment says so), clubToAgent debits the OWNER's personal wallet
     * rather than clubs.chip_treasury, and neither writes a ledger row, carries
     * an idempotency key, or asks whether the recipient is in the downline.
     */
    // Matched as code, not as a word: the comment recording why it went is
    // meant to survive, and it names the service it replaced.
    expect(CLASSIC).not.toContain("from '../services/ChipFlowService'");
    expect(CLASSIC).not.toMatch(/await ChipFlowService\./);
    expect(CLASSIC).not.toContain('balances.PLAYER.available < value');
  });

  it('the pre-flight check quotes the account the send actually spends', () => {
    expect(CLASSIC).toContain('myAgentWallet !== null && myAgentWallet < value');
    expect(CLASSIC).toContain('Insufficient chips in your agent wallet');
  });

  it('an unread float refuses nothing and authorises nothing', () => {
    // Null, never 0: a figure we could not read must not block a funded send
    // nor wave through an unfunded one. Only a KNOWN shortfall refuses.
    expect(CLASSIC).toContain('const [myAgentWallet, setMyAgentWallet] = useState<number | null>');
    expect(CLASSIC).toContain('disabled={myAgentWallet === null}');
  });

  it('every send carries an op_id, and a uuid one at that', () => {
    // fn_agent_wallet_send takes `p_op_id uuid`. The old fallback in some
    // surfaces was `${Date.now()}-${random}`, which is a 22P02 from Postgres on
    // exactly the browsers that have no crypto.randomUUID.
    for (const src of [MODAL, CLASSIC, TRADE]) {
      expect(src).toContain('p_op_id');
      expect(src).toMatch(/xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx/);
    }
  });

  it('a refusal is never toasted as a success', () => {
    // The RPCs report a refusal as { success: false, error } rather than
    // throwing. The old classic path had no result check at all.
    expect(CLASSIC).toContain("throw new Error(sendRes?.error || 'The Cashier Refused That Send')");
  });

  it('the destination follows the recipient role on every surface', () => {
    for (const src of [CLASSIC, TRADE]) {
      expect(src).toContain('canHoldAgentWallet(');
      expect(src).toContain("'agent_wallet' : 'player_wallet'");
    }
    for (const r of [...STAFF, ...AGENTS]) expect(canHoldAgentWallet(r)).toBe(true);
    expect(canHoldAgentWallet('player')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('clause 6 — the ten minute window is presented honestly', () => {
  it('seconds_left comes from the server and elapsed time is measured locally', () => {
    // 600 on the wire, nothing has happened yet.
    expect(secondsLeftFromServer(600, 0)).toBe(600);
    // Half a second in, still 600 - the countdown ticks in whole seconds.
    expect(secondsLeftFromServer(600, 500)).toBe(600);
    expect(secondsLeftFromServer(600, 1000)).toBe(599);
    expect(secondsLeftFromServer(600, 59_400)).toBe(541);
    // Runs out, and never goes negative.
    expect(secondsLeftFromServer(600, 600_000)).toBe(0);
    expect(secondsLeftFromServer(600, 999_999)).toBe(0);
  });

  it('a row the server already considers expired is never offered', () => {
    expect(secondsLeftFromServer(0, 0)).toBe(0);
    expect(secondsLeftFromServer(-30, 0)).toBe(0);
  });

  it('a missing or malformed seconds_left offers nothing rather than everything', () => {
    // Fail closed. Offering a claim we cannot time is offering a refusal.
    expect(secondsLeftFromServer(undefined, 0)).toBe(0);
    expect(secondsLeftFromServer(null, 0)).toBe(0);
    expect(secondsLeftFromServer('not a number', 0)).toBe(0);
    expect(secondsLeftFromServer(NaN, 0)).toBe(0);
  });

  it('a clock that jumps backwards cannot add time to the window', () => {
    // performance.now() is monotonic so this should not arise, but a negative
    // elapsed must clamp to zero rather than extending the deadline.
    expect(secondsLeftFromServer(600, -60_000)).toBe(600);
  });

  it('neither surface subtracts the browser wall clock from reversible_until', () => {
    /**
     * THE DEFECT THIS PINS. Both files carried a comment promising the
     * countdown was the database's, and both computed
     * `new Date(row.reversible_until).getTime() - Date.now()`. `seconds_left`
     * was selected, typed, and never read.
     */
    for (const src of [MODAL, TRADE]) {
      expect(src).toContain('secondsLeftFromServer(row.seconds_left');
      expect(src).toContain('performance.now()');
      expect(src).not.toMatch(/new Date\(row\.reversible_until\)\.getTime\(\) - nowTick/);
      expect(src).not.toMatch(/setNowTick\(Date\.now\(\)\)/);
    }
  });

  it('the empty state appears when the last row expires with the tab open', () => {
    /**
     * The modal returned null from inside .map() for an expired row, so
     * `reversible.length` stayed non-zero, the empty state never rendered, and
     * the user was left looking at a blank panel with no explanation.
     */
    expect(MODAL).toContain(
      'const stillClaimable = reversible.filter((r) => secondsLeftFor(r) > 0)'
    );
    expect(MODAL).toContain('!reversibleLoading && stillClaimable.length === 0');
    expect(MODAL).toContain('Nothing To Claim Back');
  });

  it('after the window the UI names the cash out request instead of a control', () => {
    // "They cannot remove chips from downline wallets unless their downline
    // requests a cash out." So the screen says that, rather than offering a
    // button the server would refuse.
    expect(TRADE).toContain('Nothing Is Still Inside Its Ten Minute Window');
    expect(TRADE).toContain('Request A Cash Out');
    // The modal's version of the same sentence is the claim blurb, which lives
    // in cashierModes so it can be asserted rather than scraped.
    expect(destinationBlurb('agent_wallet', 'player_wallet', 'claim')).toContain(
      'The Player Must Request A Cash Out'
    );
    expect(MODAL).toContain('Only Sends Made In The Last Ten Minutes Can Be Undone');
  });

  it('the claim is anchored on one send, never on a balance', () => {
    for (const src of [MODAL, TRADE]) {
      expect(src).toContain('p_transaction_id: row.transaction_id');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the cashier never offers a recipient the server will refuse', () => {
  it('self is excluded from the agent and promo cashiers, and kept for the bank', () => {
    /**
     * fn_agent_wallet_send and fn_promo_wallet_send refuse
     * `p_to_user_id = auth.uid()`. fn_club_bank_send deliberately does not:
     * an owner funding their OWN float out of the treasury is how an owner gets
     * a float at all, so removing themselves there would cut the funding route
     * the whole hierarchy hangs off.
     */
    expect(cashierRefusesSelfSend('agent_wallet')).toBe(true);
    expect(cashierRefusesSelfSend('promo_wallet')).toBe(true);
    expect(cashierRefusesSelfSend('club_bank')).toBe(false);
    /* 2026-09-05: the promo cashier has two accounts. The CLUB'S promo pot is
       club money and, like the Club Bank, may fund the owner's own float;
       fn_club_promo_wallet_send accepts the caller. The agent's OWN float
       still refuses a self-send. The modal passes the source it stands at. */
    expect(cashierRefusesSelfSend('promo_wallet', 'club_pot')).toBe(false);
    expect(cashierRefusesSelfSend('promo_wallet', 'own_float')).toBe(true);
    expect(MODAL).toContain('const excludeSelf = cashierRefusesSelfSend(walletType, promoSource)');
  });

  it('a selected recipient who becomes ineligible is cleared, not left hidden', () => {
    expect(MODAL).toContain(
      'if (excludeSelf && recipient.user_id === user?.id) setRecipient(null)'
    );
  });

  it('the trade grid lists the viewer but never lets them pick themselves', () => {
    // fn_club_cashier_members returns the caller for a staff viewer (scope
    // 'all' is every active member). The row used to be deleted on arrival,
    // which made the owner unsearchable in his own cashier (Dan 2026-09-04).
    // It is listed now, marked "You", and refused by toggleSelect - see
    // tests/every-member-is-discoverable-in-the-cashier.law.test.ts.
    expect(TRADE).not.toContain('String(row.user_id) !== viewerId');
    expect(TRADE).toContain('if (id === user?.id) return prev;');
    expect(TRADE).toContain('aria-disabled={r.isSelf || undefined}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the cashier tells the truth when it cannot read a balance', () => {
  it('an unread bank does not project an after figure', () => {
    // `bank ?? 0` printed "The Wallet Would Hold -500.00 Afterwards" directly
    // under a header already showing "..." for the same number.
    expect(MODAL).toContain('amt > 0 && !overCap && bank !== null');
    expect(MODAL).not.toContain('fmt((bank ?? 0) - amt)');
    expect(MODAL).not.toContain('fmt((bank ?? 0) + amt)');
  });

  it('the amount field is named for a screen reader', () => {
    // aria-label was the EMPTY STRING, which is worse than absent: it overrides
    // the visible label and announces an unnamed spin button on the one field
    // that decides how much money moves.
    expect(MODAL).not.toContain('aria-label=""');
    expect(MODAL).toContain(
      "aria-label={tab === 'claim' ? 'Chips To Claim Back' : 'Chips To Send'}"
    );
  });

  it('amounts are formatted, never padded', () => {
    /**
     * House rule 5: format numbers with toLocaleString, never padStart. There
     * is exactly ONE padStart CALL across the three cashier surfaces and it is
     * on an mm:ss clock, not on a chip figure. Counted as call sites
     * (`.padStart(`) so the comment beside it explaining that distinction does
     * not itself trip the check.
     */
    const callSites = (src: string) => (src.match(/\.padStart\(/g) || []).length;
    expect(callSites(MODAL)).toBe(0);
    expect(callSites(CLASSIC)).toBe(0);
    expect(callSites(TRADE)).toBe(1);
    expect(TRADE).toContain("String(left % 60).padStart(2, '0')");
    // And every chip figure on all three goes through a locale formatter.
    for (const src of [MODAL, CLASSIC, TRADE]) {
      expect(src).toContain('toLocaleString');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('nothing in flight can be dismissed by accident', () => {
  it('every close path in the cashier guards on the same condition', () => {
    // `sending` alone was too narrow - it is false during a claim back and
    // during a ledger reversal - and the X in the corner checked nothing.
    expect(MODAL).toContain(
      'const inFlight = sending || claimingId !== null || reversingId !== null;'
    );
    expect(MODAL).toContain('onClick={closeIfIdle}');
    expect(MODAL).not.toContain('onClick={() => !sending && onClose()}');
  });

  it('the chip mint cannot be double submitted or escaped mid-mint', () => {
    /**
     * `if (!valid || busy) return` reads STATE, and React need not have
     * re-rendered between one tap and another 80ms later. This function burns
     * diamonds and creates chips, and fn_mint_chips_from_diamonds takes no
     * idempotency key at all, so a second delivery is a second real mint.
     */
    expect(MINT).toContain('const busyRef = useRef(false)');
    expect(MINT).toContain('if (!valid || busy || busyRef.current) return');
    expect(MINT).toContain("if (e.key === 'Escape' && !busyRef.current) onClose()");
    expect(MINT).toContain("document.body.style.overflow = 'hidden'");
    expect(MINT).toContain('if (isMounted.current) setBusy(false)');
  });

  it('the ask-for-chips overlay guards its backdrop tap like the other two', () => {
    expect(TRADE).toMatch(/onClick=\{\(\) => \{\s*if \(asking\) return;/);
  });

  it('a stale ledger page cannot paint over a newer one', () => {
    // isMounted is an unmount guard; it cannot see two overlapping reads.
    expect(MODAL).toContain('const ledgerSeqRef = useRef(0)');
    expect(MODAL).toContain('seq === ledgerSeqRef.current');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('375px first', () => {
  it('every tappable rule in the cashier reaches 44px', () => {
    // The Claim Back button was 22px tall and left-aligned in a row corner:
    // the smallest target on the screen for the most time-critical action.
    for (const selector of [
      '.cbc-x',
      '.cbc-tab',
      '.cbc-seg button',
      '.cbc-member',
      '.cbc-actions button',
      '.cbc-chip',
      '.cbc-export',
      '.cbc-undo',
      '.cbc-more',
      '.cbc-mint',
    ]) {
      const start = MODAL_CSS.indexOf(`${selector} {`);
      expect(start, `${selector} is missing`).toBeGreaterThan(-1);
      const block = MODAL_CSS.slice(start, MODAL_CSS.indexOf('}', start));
      expect(block, `${selector} is under 44px`).toMatch(/(min-height|height): 44px/);
    }
  });

  it('the panel scrolls its body rather than growing past the viewport', () => {
    expect(MODAL_CSS).toContain('max-height: 85vh');
    expect(MODAL_CSS).toMatch(/\.cbc-body \{[^}]*overflow-y: auto/);
    // And the mint stacked on top of it, which had no height bound at all.
    expect(read('src/components/wallet/ChipMintModal.css')).toContain('max-height: 92vh');
  });

  it('no dead selectors are left behind on the money surfaces', () => {
    // Dead CSS on a money surface is the next reader's evidence that a control
    // they cannot find still exists.
    for (const gone of ['.cbc-sub {', '.cbc-role {', '.cbc-quick {', '.cbc-max {']) {
      expect(MODAL_CSS).not.toContain(gone);
    }
    expect(read('src/pages/CashierTradePage.module.css')).not.toContain('.back {');
    expect(read('src/pages/CashierPage.module.css')).not.toContain('.loadingText {');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the mode rules stay where a test can pin them', () => {
  it('the club bank keeps its ledger and its claim back', () => {
    expect(cashierTabs('club_bank')).toEqual(['send', 'claim', 'ledger']);
  });

  it('the agent wallet has a claim back but no ledger of its own', () => {
    expect(cashierTabs('agent_wallet')).toEqual(['send', 'claim']);
  });

  it('a promo hand-out has no inverse, so it has no claim tab (it has a ledger since 2026-09-05)', () => {
    expect(cashierTabs('promo_wallet')).toEqual(['send', 'ledger']);
  });

  it('the agent wallet funds a player or a downline float, and nothing else', () => {
    expect(cashierDestinations('agent_wallet')).toEqual(['player_wallet', 'agent_wallet']);
  });
});
