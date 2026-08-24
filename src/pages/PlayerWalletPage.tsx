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
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { TransactionHistory } from '../components/wallet/TransactionHistory';
import DepositWithdrawModal from '../components/wallet/DepositWithdrawModal';
import DisputeSubmitModal from '../components/wallet/DisputeSubmitModal';

import TransactionLedgerView from '../components/common/TransactionLedgerView';
import './PlayerWalletPage.css';
import { reportError } from '../utils/errorReporter';

type WalletTab = 'overview' | 'transfer' | 'history';
type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER HOOK — Smooth number transitions
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedNumber(target: number, duration = 800) {
  const [display, setDisplay] = useState(0);
  const prevTarget = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = prevTarget.current;
    const delta = target - start;
    if (delta === 0) return;

    let startTime: number;
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const animate = (now: number) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = easeOutCubic(progress);
      setDisplay(Math.round(start + delta * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplay(target);
        prevTarget.current = target;
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
  }, [target, duration]);

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
    description: 'Table Buy-ins & Gameplay',
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
      masterBus.subscribeDebounced(
        'CHIPS_WITHDRAWN',
        () => {
          loadBalances(user.id, { force: true });
        },
        500
      ),
      // Refresh when new chip_ledger transactions arrive
      masterBus.subscribeDebounced(
        'TRANSACTION_LOGGED' as any,
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
    if (isNaN(amount) || amount <= 0) {
      setMessage({ type: 'error', text: 'Please enter a valid amount' });
      return;
    }
    if (transferFrom === transferTo) {
      setMessage({ type: 'error', text: 'Cannot transfer to the same wallet' });
      return;
    }
    if (amount > balances[transferFrom].available) {
      setMessage({
        type: 'error',
        text: `Insufficient balance. Available: ${balances[transferFrom].available.toLocaleString()}`,
      });
      return;
    }
    setIsTransferring(true);
    setMessage(null);
    try {
      if (!user?.id) return;
      await internalTransfer(user.id, transferFrom, transferTo, amount);
      if (isMounted.current) {
        setMessage({
          type: 'success',
          text: `Transferred ${amount.toLocaleString()} chips successfully!`,
        });
        setTransferAmount('');
      }
      loadBalances(user.id);
      masterBus.emit('BALANCE_UPDATED', { source: 'internal_transfer', userId: user.id });
    } catch (e) {
      reportError(e, 'PlayerWalletPage');
      if (isMounted.current)
        setMessage({ type: 'error', text: 'Transfer failed. Please try again.' });
    }
    if (isMounted.current) setIsTransferring(false);
  };

  // ── Keyboard navigation for tabs (Arrow Left/Right) ──
  const walletTabs: WalletTab[] = ['overview', 'transfer', 'history'];
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = walletTabs.indexOf(activeTab);
        const next =
          e.key === 'ArrowRight'
            ? walletTabs[(idx + 1) % walletTabs.length]
            : walletTabs[(idx - 1 + walletTabs.length) % walletTabs.length];
        setActiveTab(next);
        const btn = document.querySelector(`[aria-controls="wallet-panel-${next}"]`) as HTMLElement;
        btn?.focus();
      }
    },
    [activeTab]
  );

  return (
    <div className="wallet-page">
      {/* ═══════════ HERO BALANCE CARD ═══════════ */}
      <div className="wallet-hero">
        <div className="hero-label">Total Balance</div>
        <div className="hero-balance">{animatedTotal.toLocaleString()}</div>
        <div className="hero-diamonds" role="button" tabIndex={0} aria-label="View diamond balance">
          <span className="diamond-glyph">◆</span>
          <span>{animatedDiamonds.toLocaleString()}</span>
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
          <button className="hero-btn secondary" onClick={() => setShowDisputeModal(true)}>
            ⚠ Dispute
          </button>
        </div>
      </div>

      {/* ═══════════ TABS ═══════════ */}
      <div
        className="wallet-tabs"
        role="tablist"
        aria-label="Wallet sections"
        onKeyDown={handleTabKeyDown}
      >
        {(['overview', 'transfer', 'history'] as WalletTab[]).map((tab) => (
          <button
            key={tab}
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
      <div className="wallet-content">
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
                  aria-label="Transfer from wallet"
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
                  aria-label="Transfer to wallet"
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
                  aria-label="Transfer amount"
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
        isOpen={showDisputeModal}
        onClose={() => setShowDisputeModal(false)}
        clubId=""
      />
    </div>
  );
}
