/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER WALLET PAGE — Premium Financial Engine (Q2 Upgrade)
 *  Color-coded Triple-Wallet + Animated Counters + Sparkline Bars
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';
import { useWalletStore } from '../stores/useWalletStore';
import { useUserStore } from '../stores/useUserStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { TransactionHistory } from '../components/wallet/TransactionHistory';
import DepositWithdrawModal from '../components/wallet/DepositWithdrawModal';
import DisputeSubmitModal from '../components/wallet/DisputeSubmitModal';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';

import TransactionLedgerView from '../components/common/TransactionLedgerView';
import './PlayerWalletPage.css';
import { reportError } from '../utils/errorReporter';

type WalletTab = 'overview' | 'transfer' | 'history';
type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

/** One list, module scope, used by both the tablist and its keyboard handler. */
const WALLET_TABS: WalletTab[] = ['overview', 'transfer', 'history'];

/**
 * In-page messages are not toasts, so `formatPopupText` (which the Toast layer
 * applies for every popup in the app) never touched them. Dan's casing law is
 * about what the PLAYER reads, not about which component renders it, so the
 * strings below are written in the same Title Case the toasts come out in.
 */
const MSG = {
  invalidAmount: 'Please Enter A Valid Amount',
  sameWallet: 'Cannot Transfer To The Same Wallet',
  transferFailed: 'Transfer Failed. Please Try Again',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER HOOK — Smooth number transitions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * AUDIT 2026-08-25. Two defects, both of the class DynamicWallet's own counter
 * documents at length:
 *
 *  1. A NON-FINITE TARGET WAS PERMANENT. `NaN - 0` is NaN, `NaN === 0` is
 *     false, so the animation ran, `Math.round(NaN)` committed NaN, and
 *     `prevTarget` was then set to NaN at the end of the frame - after which
 *     every later target computed `NaN - NaN` and the figure was stuck at
 *     "NaN" for the life of the page. `balances[type].total` comes from a
 *     store fed by a network read; one `undefined` is all it takes.
 *
 *  2. THE START POINT WENT STALE ON EVERY INTERRUPTION. `prevTarget` was only
 *     written in the FINAL frame, and the cleanup cancels the animation the
 *     moment the target moves. So a balance that changed twice in under 800ms -
 *     which is exactly what a buy-in followed by its bus refresh looks like -
 *     started its second animation from the value BEFORE the first, and the
 *     number visibly jumped backwards before running forwards again.
 *     `currentRef` now tracks what is actually on screen, written by the frame
 *     that draws it.
 */
function useAnimatedNumber(target: number, duration = 800) {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [display, setDisplay] = useState(safeTarget);
  /** What the screen is showing RIGHT NOW, not what it last settled on. */
  const currentRef = useRef(safeTarget);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = currentRef.current;
    const delta = safeTarget - start;
    if (!Number.isFinite(delta) || delta === 0) {
      currentRef.current = safeTarget;
      setDisplay(safeTarget);
      return;
    }

    let startTime: number | null = null;
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const animate = (now: number) => {
      if (startTime === null) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = easeOutCubic(progress);
      const next = Math.round(start + delta * eased);
      currentRef.current = next;
      setDisplay(next);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        currentRef.current = safeTarget;
        setDisplay(safeTarget);
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [safeTarget, duration]);

  return display;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET CONFIG — Color-coded wallet definitions
// ═══════════════════════════════════════════════════════════════════════════════

const WALLET_CONFIG: Record<
  WalletType,
  {
    icon: string;
    label: string;
    description: string;
    cssClass: string;
  }
> = {
  BUSINESS: {
    icon: '◈',
    label: 'Business',
    description: 'Commissions & Settlements',
    cssClass: 'business',
  },
  PLAYER: {
    icon: '♠',
    label: 'Player',
    description: 'Table Buy-Ins & Gameplay',
    cssClass: 'player',
  },
  PROMO: {
    icon: '★',
    label: 'Promo',
    description: 'Bonuses & Rewards',
    cssClass: 'promo',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET CARD COMPONENT — Premium color-coded card with sparkline
// ═══════════════════════════════════════════════════════════════════════════════

function WalletCard({
  type,
  available,
  locked,
  total,
  totalOfAll,
  visible,
}: {
  type: WalletType;
  available: number;
  locked: number;
  total: number;
  totalOfAll: number;
  visible: boolean;
}) {
  const config = WALLET_CONFIG[type];
  const animatedAvail = useAnimatedNumber(available);
  const animatedLocked = useAnimatedNumber(locked);
  const animatedTotal = useAnimatedNumber(total);
  const sparkPct = totalOfAll > 0 ? Math.min((total / totalOfAll) * 100, 100) : 0;

  return (
    <div
      className={`wallet-card-premium ${config.cssClass}`}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className="wc-header">
        <div className="wc-icon">{config.icon}</div>
        <div>
          <div className="wc-name">{config.label}</div>
          <div className="wc-desc">{config.description}</div>
        </div>
      </div>

      <div className="wc-balances">
        <div className="wc-stat">
          <div className="wc-stat-value available">{animatedAvail.toLocaleString()}</div>
          <div className="wc-stat-label">Available</div>
        </div>
        <div className="wc-stat">
          <div className="wc-stat-value locked">{animatedLocked.toLocaleString()}</div>
          <div className="wc-stat-label">Locked</div>
        </div>
        <div className="wc-stat">
          <div className="wc-stat-value total">{animatedTotal.toLocaleString()}</div>
          <div className="wc-stat-label">Total</div>
        </div>
      </div>

      {/* Sparkline bar showing proportion of total balance */}
      <div className="wc-sparkline">
        <div className="wc-sparkline-fill" style={{ width: `${sparkPct}%` }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

import { useRealtimeFinancials } from '../hooks/useRealtimeFinancials';

export default function PlayerWalletPage() {
  useRealtimeFinancials();
  useEffect(() => {
    document.title = 'Wallet | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const { user } = useAuthUser();
  const { balances, diamonds, loadBalances, loadDiamonds, internalTransfer } = useWalletStore();
  /**
   * A dispute is filed AGAINST A CLUB, and this page is not club-scoped — so
   * the Dispute button used to open a modal hard-wired to `clubId=""`.
   * DisputeService writes that straight through to a uuid column, so every
   * dispute filed from the wallet page failed with 22P02 (invalid input syntax
   * for type uuid) and the player was told "Failed To Submit Dispute. Please
   * Try Again" for something that could never succeed however many times they
   * tried. The club the player last entered is the honest context; with no club
   * at all there is nothing to dispute against, and the button says so instead
   * of opening.
   */
  const currentClubId = useUserStore((s) => s.currentClubId);
  // force: the tab has been hidden and is now back. The freshness window exists
  // to make navigation free, not to serve a number that may be minutes old to
  // somebody who just returned and is looking straight at it.
  useVisibilityRefresh(() => {
    if (user?.id) {
      loadBalances(user.id, { force: true });
      loadDiamonds(user.id, { force: true });
    }
  });

  const [activeTab, setActiveTab] = useState<WalletTab>('overview');
  const [transferFrom, setTransferFrom] = useState<WalletType>('PLAYER');
  const [transferTo, setTransferTo] = useState<WalletType>('BUSINESS');
  const [transferAmount, setTransferAmount] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const isMounted = useIsMounted();

  const [visibleCards, setVisibleCards] = useState(new Set<number>());

  // Auto-dismiss messages after 8s
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      if (isMounted.current) setMessage(null);
    }, 8000);
    return () => clearTimeout(t);
  }, [message]);

  // Stagger wallet cards animation
  useEffect(() => {
    const timers = [0, 1, 2].map((i) =>
      setTimeout(() => setVisibleCards((prev) => new Set([...prev, i])), 150 + i * 100)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  // Load wallet data
  useEffect(() => {
    if (user?.id) {
      loadBalances(user.id);
      loadDiamonds(user.id);
    }
  }, [user?.id, loadBalances, loadDiamonds]);

  // ── Realtime wallet updates: now GLOBAL, not page-scoped ──────────────────
  //
  // A `user-wallet-<uid>` channel used to live here, subscribing to `wallets`
  // filtered by user_id and calling loadBalances/loadDiamonds. It was removed on
  // 2026-08-24 for two reasons, which are the same bug seen from two sides:
  //
  //  1. It was PAGE-SCOPED. Its cleanup called removeRegisteredChannel, so
  //     leaving /wallet tore the subscription down and returning re-negotiated
  //     it - precisely the "re-sync every time you change pages" behaviour this
  //     pass exists to remove.
  //  2. It was the ONLY live `wallets` listener in the app. Sitting anywhere
  //     else - Home, the lobby, a table - a balance changed server-side reached
  //     the player not at all.
  //
  // The identical, user-filtered listener now lives in PostgresSyncHooks'
  // `global_db_sync:<userId>` channel, created once at sign-in and never torn
  // down by navigation. It emits BALANCE_UPDATED, which useGlobalBalanceSync
  // (mounted in App.tsx) already consumes debounced and turns into a single
  // authoritative refetch. So this page keeps live updates, gets them without
  // re-subscribing, and every OTHER page gains them too.

  // ── Bus Listeners ──
  useEffect(() => {
    if (!user?.id) return;
    const unsubs = [
      masterBus.subscribeDebounced(
        'BALANCE_UPDATED',
        () => {
          loadBalances(user.id, { force: true });
          loadDiamonds(user.id, { force: true });
        },
        500
      ),
      masterBus.subscribeDebounced(
        'WALLET_REFRESHED',
        () => {
          loadBalances(user.id, { force: true });
          loadDiamonds(user.id, { force: true });
        },
        500
      ),
      masterBus.subscribeDebounced(
        'CHIPS_ADDED',
        () => {
          loadBalances(user.id, { force: true });
        },
        500
      ),
      // Refresh when new chip_ledger transactions arrive.
      //
      // THE `as any` IS NOT SLOPPINESS, IT IS A BUG IN MasterBus.ts, and it is
      // load-bearing until that file is fixed. 'TRANSACTION_LOGGED' has a
      // payload declared in `BusPayloadMap` (MasterBus.ts:364) but is MISSING
      // from the `BusEventType` union (MasterBus.ts:34), and every subscribe
      // signature is keyed on the union - so the event is emittable, has a
      // typed payload, and cannot be subscribed to without a cast. Five call
      // sites across the app carry the identical cast for the identical
      // reason (CashierPage, ClubFinancialsPage, SettlementDashboardPage,
      // TransactionLedgerView, and this one). Removing the cast here is a
      // compile error; the fix is one line in MasterBus.ts, which is outside
      // this pass. Reported 2026-08-25.
      masterBus.subscribeDebounced(
        'TRANSACTION_LOGGED',
        () => {
          loadBalances(user.id, { force: true });
          loadDiamonds(user.id, { force: true });
        },
        1000
      ),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [user?.id, loadBalances, loadDiamonds]);

  const totalBalance = balances.BUSINESS.total + balances.PLAYER.total + balances.PROMO.total;
  const animatedTotal = useAnimatedNumber(totalBalance, 1000);
  const animatedDiamonds = useAnimatedNumber(diamonds, 800);

  const handleTransfer = async () => {
    const amount = parseFloat(transferAmount);
    // `parseFloat` accepts Infinity and, on a `type="number"` field, whatever a
    // paste puts there. A non-finite amount reached the RPC as `Infinity`.
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage({ type: 'error', text: MSG.invalidAmount });
      return;
    }
    if (transferFrom === transferTo) {
      setMessage({ type: 'error', text: MSG.sameWallet });
      return;
    }
    if (amount > balances[transferFrom].available) {
      setMessage({
        type: 'error',
        text: `Insufficient Balance. Available: ${balances[transferFrom].available.toLocaleString()}`,
      });
      return;
    }
    setIsTransferring(true);
    setMessage(null);
    try {
      if (!user?.id) return;
      // 2026-08-27: internalTransfer NEVER throws - it returns false on the
      // store mutex skip, on insufficient balance, and on every RPC failure
      // (the store swallows those into reportError). This success message used
      // to fire unconditionally after the await, so a REFUSED transfer told
      // the player it succeeded, cleared their input and emitted
      // BALANCE_UPDATED. The catch below was dead for every store-level
      // failure. Honour the boolean.
      const transferred = await internalTransfer(user.id, transferFrom, transferTo, amount);
      if (!transferred) {
        if (isMounted.current) {
          setMessage({ type: 'error', text: MSG.transferFailed });
          setIsTransferring(false);
        }
        return;
      }
      if (isMounted.current) {
        setMessage({
          type: 'success',
          text: `Transferred ${amount.toLocaleString()} Chips Successfully`,
        });
        setTransferAmount('');
      }
      loadBalances(user.id, { force: true });
      masterBus.emit('BALANCE_UPDATED', { source: 'internal_transfer', userId: user.id });
    } catch (e) {
      reportError(e, 'PlayerWalletPage.handleTransfer');
      if (isMounted.current) setMessage({ type: 'error', text: MSG.transferFailed });
    }
    if (isMounted.current) setIsTransferring(false);
  };

  // ── Keyboard navigation for tabs (Arrow Left/Right) ──
  // WALLET_TABS is module scope: it was rebuilt on every render and closed over
  // by a useCallback that did not list it, which is a stale-closure trap left
  // armed for whoever adds a fourth tab.
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = WALLET_TABS.indexOf(activeTab);
        const next =
          e.key === 'ArrowRight'
            ? WALLET_TABS[(idx + 1) % WALLET_TABS.length]
            : WALLET_TABS[(idx - 1 + WALLET_TABS.length) % WALLET_TABS.length];
        setActiveTab(next);
        document.getElementById(`wallet-tab-${next}`)?.focus();
      }
    },
    [activeTab]
  );

  return (
    <div className="wallet-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Wallet"
        title="Your Value Vault"
        description="One Secure Command Surface For Playable Chips, Protected Balances, Club Earnings, Promotional Value, And Diamonds. Every Figure Below Remains Connected To The Live Wallet Ledger."
        art="vault"
        status="WALLET LEDGER // SYNCHRONIZED"
        metrics={[
          {
            label: 'Playable Now',
            value: balances.PLAYER.available.toLocaleString(),
            tone: 'live',
          },
          { label: 'All Wallets', value: animatedTotal.toLocaleString() },
          { label: 'Diamonds', value: animatedDiamonds.toLocaleString(), tone: 'attention' },
        ]}
      />
      {/* ═══════════ HERO BALANCE CARD ═══════════ */}
      <div className="wallet-hero">
        {/* "Total Balance" was a lie of omission. This figure is BUSINESS +
            PLAYER + PROMO, and only the PLAYER wallet buys into a game: an
            agent with 40,000 in commissions and 200 in chips read "Total
            Balance 40,200" and then could not sit down for 400. Different
            accounts do not become one balance by being summed, so the label
            says what the sum IS and the playable figure is stated beside it.
            (The same rule, one level up: an agent's float and a member's chip
            balance live in different tables and must never share a label.) */}
        <div className="hero-label">All Wallets Combined</div>
        <div className="hero-balance">{animatedTotal.toLocaleString()}</div>
        <div className="hero-sublabel">
          Playable Now: {balances.PLAYER.available.toLocaleString()}
        </div>
        {/* A READOUT, not a control. This carried role="button" and tabIndex={0}
            with no onClick and no onKeyDown: a keyboard or screen-reader user
            was offered a "View diamond balance" button, tabbed to it, pressed
            Enter, and nothing happened. (It was also a 30px target, under the
            44px guideline, for a control that did not exist.) DynamicWallet's
            BBJ banner was fixed for the same reason - see `bbjClickable` there.
            If a diamond wallet ever opens from here, wire the handler and the
            affordance back together in the same commit. */}
        <div className="hero-diamonds">
          <span className="diamond-glyph" aria-hidden="true">
            ◆
          </span>
          <span aria-label={`${animatedDiamonds.toLocaleString()} Diamonds`}>
            {animatedDiamonds.toLocaleString()}
          </span>
        </div>

        {/* Escrow Transparency Badge */}
        {balances.PLAYER.locked > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              marginTop: '8px',
              background: 'rgba(255, 167, 38, 0.08)',
              border: '1px solid rgba(255, 167, 38, 0.2)',
              borderRadius: '20px',
              fontSize: '0.75rem',
              color: '#ffa726',
            }}
          >
            <span>◈</span>
            <span>{balances.PLAYER.locked.toLocaleString()} Chips In Escrow</span>
            <span style={{ marginLeft: 'auto', fontSize: '0.65rem', opacity: 0.7 }}>
              Funds Secured
            </span>
          </div>
        )}

        <div className="hero-actions">
          <button className="hero-btn deposit" onClick={() => setShowDepositModal(true)}>
            + Deposit
          </button>
          <button className="hero-btn withdraw" onClick={() => setShowWithdrawModal(true)}>
            Withdraw
          </button>
          <button className="hero-btn secondary" onClick={() => navigate('/rakeback')}>
            Rakeback
          </button>
          <button className="hero-btn secondary" onClick={() => navigate('/transactions')}>
            History
          </button>
          <button
            className="hero-btn secondary"
            onClick={() => setShowDisputeModal(true)}
            disabled={!currentClubId}
            title={
              currentClubId ? 'Raise A Dispute' : 'Enter A Club First To Raise A Dispute There'
            }
          >
            ⚠ Dispute
          </button>
        </div>
      </div>

      {/* ═══════════ TABS ═══════════ */}
      <div
        className="wallet-tabs"
        role="tablist"
        aria-label="Wallet Sections"
        onKeyDown={handleTabKeyDown}
      >
        {WALLET_TABS.map((tab) => (
          <button
            key={tab}
            /* `id` added 2026-08-25. The panel below points back here with
               aria-labelledby, and without an id that reference dangled. */
            id={`wallet-tab-${tab}`}
            role="tab"
            tabIndex={activeTab === tab ? 0 : -1}
            aria-selected={activeTab === tab}
            aria-controls={`wallet-panel-${tab}`}
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' ? 'Wallets' : tab === 'transfer' ? 'Transfer' : 'Ledger'}
          </button>
        ))}
      </div>

      {/* ═══════════ TAB CONTENT ═══════════ */}
      {/* Every tab already advertised `aria-controls="wallet-panel-<tab>"` and
          NO element in the document carried that id, nor role="tabpanel" - so
          the tablist announced three panels that assistive tech could not find,
          and a screen reader following the relationship landed nowhere. One
          panel element, re-identified as the active tab changes, is the correct
          shape for a tablist that renders only the selected pane. */}
      <div
        className="wallet-content"
        id={`wallet-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`wallet-tab-${activeTab}`}
      >
        {/* OVERVIEW — Color-coded wallet cards */}
        {activeTab === 'overview' && (
          <div className="wallet-cards-stack">
            {(Object.keys(WALLET_CONFIG) as WalletType[]).map((type, index) => (
              <WalletCard
                key={type}
                type={type}
                available={balances[type].available}
                locked={balances[type].locked}
                total={balances[type].total}
                totalOfAll={totalBalance}
                visible={visibleCards.has(index)}
              />
            ))}
          </div>
        )}

        {/* TRANSFER */}
        {activeTab === 'transfer' && (
          <div className="transfer-section">
            <h3>Internal Transfer</h3>
            <p
              style={{
                color: '#5a6a7a',
                textAlign: 'center',
                margin: '0 0 16px',
                fontSize: '0.85rem',
              }}
            >
              Move Funds Between Your Wallets Instantly
            </p>

            <div className="transfer-form">
              <div>
                <span className="transfer-label">From</span>
                <select
                  className="transfer-select"
                  value={transferFrom}
                  onChange={(e) => setTransferFrom(e.target.value as WalletType)}
                  aria-label="Transfer From Wallet"
                >
                  {(Object.keys(WALLET_CONFIG) as WalletType[]).map((type) => (
                    <option key={type} value={type}>
                      {WALLET_CONFIG[type].icon} {WALLET_CONFIG[type].label} (
                      {balances[type].available.toLocaleString()})
                    </option>
                  ))}
                </select>
              </div>

              <div className="transfer-arrow" aria-hidden="true">
                ↓
              </div>

              <div>
                <span className="transfer-label">To</span>
                <select
                  className="transfer-select"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value as WalletType)}
                  aria-label="Transfer To Wallet"
                >
                  {(Object.keys(WALLET_CONFIG) as WalletType[]).map((type) => (
                    <option key={type} value={type}>
                      {WALLET_CONFIG[type].icon} {WALLET_CONFIG[type].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="transfer-input-wrap">
                <span className="transfer-label">Amount</span>
                <input
                  type="number"
                  placeholder="0.00"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  aria-label="Transfer Amount"
                  inputMode="decimal"
                  min="0"
                />
              </div>

              {message && <div className={`message ${message.type}`}>{message.text}</div>}

              <button
                className="transfer-btn"
                onClick={handleTransfer}
                disabled={isTransferring || !transferAmount}
              >
                {isTransferring ? 'Transferring...' : 'Transfer'}
              </button>
            </div>
          </div>
        )}

        {/* HISTORY */}
        {activeTab === 'history' && user?.id && (
          <div
            style={{
              background: 'rgba(255,255,255,0.02)',
              borderRadius: '16px',
              padding: '1rem',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <TransactionHistory walletId={user.id} limit={50} />
          </div>
        )}

        {/* Chip Ledger Audit Trail — only visible on history tab */}
        {activeTab === 'history' && user?.id && (
          <div
            style={{
              background: 'rgba(255,255,255,0.02)',
              borderRadius: '16px',
              padding: '1rem',
              border: '1px solid rgba(255,255,255,0.04)',
              marginTop: '12px',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#e0e0e0' }}>
              Chip Movement Audit Trail
            </h3>
            <TransactionLedgerView userId={user.id} limit={20} />
          </div>
        )}
      </div>

      {/* ═══════════ MODALS ═══════════ */}
      <DepositWithdrawModal
        isOpen={showDepositModal}
        onClose={() => setShowDepositModal(false)}
        mode="deposit"
        userId={user?.id || ''}
        currentBalance={balances.PLAYER.available}
        onComplete={() => user?.id && loadBalances(user.id)}
      />
      <DepositWithdrawModal
        isOpen={showWithdrawModal}
        onClose={() => setShowWithdrawModal(false)}
        mode="withdraw"
        userId={user?.id || ''}
        currentBalance={balances.PLAYER.available}
        onComplete={() => user?.id && loadBalances(user.id)}
      />
      <DisputeSubmitModal
        isOpen={showDisputeModal && Boolean(currentClubId)}
        onClose={() => setShowDisputeModal(false)}
        clubId={currentClubId ?? ''}
      />
    </div>
  );
}
