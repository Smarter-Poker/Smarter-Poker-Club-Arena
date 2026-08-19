/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WALLET MODAL — Transaction History Popup
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `components/store/DiamondWalletModal.jsx`.
 *
 * Opens when user clicks the diamond balance in the header.
 * Shows full-screen transaction history with filtering.
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { DiamondService } from '../../services/DiamondService';
import { useAuthUser } from '../../hooks/useAuthUser';
import './DiamondWalletModal.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface DiamondWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBuyClick?: () => void;
}

interface DiamondTransaction {
  id: string;
  type: string;
  transaction_type?: string;
  amount: number;
  description?: string;
  balance_after?: number;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TX TYPE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const TX_TYPES: Record<string, { icon: string; label: string; color: string }> = {
  purchase: { icon: 'cart', label: 'Purchase', color: '#ef4444' },
  feature_unlock: { icon: 'unlock', label: 'Feature Unlock', color: '#f97316' },
  game_cost: { icon: 'gamepad', label: 'Game Entry', color: '#ef4444' },
  arcade_entry: { icon: 'joystick', label: 'Arcade Entry', color: '#ef4444' },
  bonus: { icon: 'gift', label: 'Bonus', color: '#a855f7' },
  signup_bonus: { icon: 'celebration', label: 'Welcome Bonus', color: '#a855f7' },
  daily_bonus: { icon: 'calendar', label: 'Daily Bonus', color: '#3b82f6' },
  daily_login: { icon: 'calendar', label: 'Daily Login', color: '#3b82f6' },
  daily_trivia: { icon: 'puzzle', label: 'Daily Trivia', color: '#8b5cf6' },
  streak_reward: { icon: 'flame', label: 'Streak Reward', color: '#ff6600' },
  vip_reward: { icon: 'crown', label: 'VIP Reward', color: '#eab308' },
  vip_stipend: { icon: 'crown', label: 'VIP Stipend', color: '#eab308' },
  achievement: { icon: 'trophy', label: 'Achievement', color: '#f59e0b' },
  challenge: { icon: 'lightning', label: 'Challenge', color: '#06b6d4' },
  tournament_prize: { icon: 'gold_medal', label: 'Tournament Prize', color: '#eab308' },
  tournament_refund: { icon: 'refresh', label: 'Tournament Refund', color: '#94a3b8' },
  pvp_win: { icon: 'crossed_swords', label: 'PvP Win', color: '#22c55e' },
  pvp_refund: { icon: 'refresh', label: 'PvP Refund', color: '#94a3b8' },
  game_reward: { icon: 'target', label: 'Game Reward', color: '#22c55e' },
  trivia_reward: { icon: 'brain', label: 'Trivia Reward', color: '#8b5cf6' },
  social_post: { icon: 'memo', label: 'Social Post', color: '#ec4899' },
  follow: { icon: 'person', label: 'Follow Reward', color: '#06b6d4' },
  reaction: { icon: 'heart', label: 'Reaction Reward', color: '#f43f5e' },
  comment: { icon: 'comment', label: 'Comment Reward', color: '#06b6d4' },
  share: { icon: 'link', label: 'Share Reward', color: '#3b82f6' },
  referral: { icon: 'handshake', label: 'Referral Bonus', color: '#10b981' },
  profile_complete: { icon: 'checkmark', label: 'Profile Bonus', color: '#22c55e' },
  profile_pic: { icon: 'camera', label: 'Profile Pic Bonus', color: '#06b6d4' },
  video_watch: { icon: 'filmstrip', label: 'Video Watch', color: '#8b5cf6' },
  video_favorite: { icon: 'star', label: 'Video Favorite', color: '#eab308' },
  hendonmob_link: { icon: 'link', label: 'HendonMob Link', color: '#10b981' },
  venue_review: { icon: 'location', label: 'Venue Review', color: '#f59e0b' },
  promo_code: { icon: 'ticket', label: 'Promo Code', color: '#a855f7' },
  refund: { icon: 'refresh', label: 'Refund', color: '#94a3b8' },
  adjustment: { icon: 'settings', label: 'Adjustment', color: '#94a3b8' },
  mint: { icon: 'coin', label: 'Chip Mint', color: '#22c55e' },
  diamond_purchase: { icon: 'gem', label: 'Diamond Purchase', color: '#00d4ff' },
  diamond_deduction: { icon: 'gem', label: 'Diamond Spent', color: '#ef4444' },
  diamond_reward: { icon: 'gem', label: 'Diamond Reward', color: '#22c55e' },
  diamond_refund: { icon: 'gem', label: 'Diamond Refund', color: '#94a3b8' },
};

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'earned', label: 'Earned' },
  { value: 'spent', label: 'Spent' },
  { value: 'refund', label: 'Refunds' },
];

const EARNED_TYPES = [
  'bonus',
  'signup_bonus',
  'daily_bonus',
  'daily_login',
  'daily_trivia',
  'streak_reward',
  'achievement',
  'challenge',
  'tournament_prize',
  'pvp_win',
  'game_reward',
  'trivia_reward',
  'vip_reward',
  'vip_stipend',
  'social_post',
  'follow',
  'reaction',
  'comment',
  'share',
  'referral',
  'profile_complete',
  'profile_pic',
  'video_watch',
  'video_favorite',
  'hendonmob_link',
  'venue_review',
  'promo_code',
  'diamond_purchase',
  'diamond_reward',
  'diamond_refund',
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DiamondWalletModal({
  isOpen,
  onClose,
  onBuyClick,
}: DiamondWalletModalProps) {
  const { user } = useAuthUser();
  const [transactions, setTransactions] = useState<DiamondTransaction[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const isMounted = useIsMounted();

  const fetchTransactions = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      // Get balance from Triple-Wallet Architecture source-of-truth
      const diamondWallet = await DiamondService.getBalance(user.id);

      if (isMounted.current) setBalance(diamondWallet.balance || 0);

      // Get transactions from wallet_transactions (diamond-related)
      const { data: txData } = await supabase
        .from('wallet_transactions')
        .select('id, type, amount, description, balance_after, created_at, category')
        .eq('user_id', user.id)
        .in('category', [
          'diamond_purchase',
          'diamond_deduction',
          'vip_purchase',
          'mint',
          'diamond_reward',
          'diamond_refund',
        ])
        .order('created_at', { ascending: false })
        .limit(50);

      // Also try diamond_transactions table if it exists
      const { data: dtData } = await supabase
        .from('diamond_transactions')
        .select('id, transaction_type, amount, description, balance_after, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      // Combine both sources
      const combined: DiamondTransaction[] = [
        ...(txData || []).map((t: any) => ({
          id: t.id,
          type: t.type,
          transaction_type: t.category,
          amount: t.amount,
          description: t.description,
          balance_after: t.balance_after,
          created_at: t.created_at,
        })),
        ...(dtData || []).map((t: any) => ({
          id: t.id,
          type: t.transaction_type,
          transaction_type: t.transaction_type,
          amount: t.amount,
          description: t.description,
          balance_after: t.balance_after,
          created_at: t.created_at,
        })),
      ]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 50);

      if (isMounted.current) setTransactions(combined);
    } catch (err) {
      reportError(err, 'DiamondWalletModal.Fetch_error');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (isOpen) fetchTransactions();
  }, [isOpen, fetchTransactions]);

  // Refresh when diamond balance changes from another component
  useMasterBusSubscription('DIAMOND_BALANCE_CHANGED', () => {
    if (isMounted.current && isOpen) fetchTransactions();
  });

  // Client-side filter
  const filteredTx = transactions.filter((tx) => {
    const txType = tx.transaction_type || tx.type;
    if (filter === 'all') return true;
    if (filter === 'earned') return EARNED_TYPES.includes(txType);
    if (filter === 'spent')
      return tx.amount < 0 && !['refund', 'tournament_refund', 'pvp_refund'].includes(txType);
    return txType === filter;
  });

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="diamond-wallet-backdrop" onClick={onClose} />

      {/* Modal — Full Screen */}
      <div className="diamond-wallet-modal">
        {/* Close button */}
        <div className="diamond-wallet-modal__close-row">
          <button className="diamond-wallet-modal__close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Header — Balance Display */}
        <div className="diamond-wallet-modal__header">
          <div className="diamond-wallet-modal__header-label">Diamond Wallet</div>
          <div className="diamond-wallet-modal__balance-row">
            <span className="diamond-wallet-modal__balance-icon">◆</span>
            <span className="diamond-wallet-modal__balance-value">
              {loading ? '...' : balance.toLocaleString()}
            </span>
          </div>
          <button
            className="diamond-wallet-modal__buy-btn"
            onClick={() => {
              onClose();
              onBuyClick?.();
            }}
          >
            + Buy Diamonds
          </button>
        </div>

        {/* Filter Bar */}
        <div className="diamond-wallet-modal__filters">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`diamond-wallet-modal__filter ${filter === opt.value ? 'diamond-wallet-modal__filter--active' : ''}`}
              onClick={() => setFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Transaction List */}
        <div className="diamond-wallet-modal__list">
          {loading ? (
            <div className="diamond-wallet-modal__status">Loading transactions...</div>
          ) : filteredTx.length === 0 ? (
            <div className="diamond-wallet-modal__status">
              <div style={{ fontSize: 32, marginBottom: 8 }}>◆</div>
              No transactions yet
            </div>
          ) : (
            filteredTx.map((tx) => {
              const txType = tx.transaction_type || tx.type;
              const config = TX_TYPES[txType] || TX_TYPES.adjustment;
              const isPositive = tx.amount >= 0;
              const dt = new Date(tx.created_at);

              return (
                <div key={tx.id} className="diamond-wallet-modal__tx">
                  <div
                    className="diamond-wallet-modal__tx-icon"
                    style={{ backgroundColor: `${config.color}15` }}
                  >
                    {config.icon}
                  </div>
                  <div className="diamond-wallet-modal__tx-body">
                    <div className="diamond-wallet-modal__tx-label">{config.label}</div>
                    <div className="diamond-wallet-modal__tx-desc">
                      {tx.description || config.label}
                    </div>
                  </div>
                  <div className="diamond-wallet-modal__tx-amount-col">
                    <span
                      className="diamond-wallet-modal__tx-amount"
                      style={{ color: isPositive ? '#4ade80' : '#f87171' }}
                    >
                      {isPositive ? '+' : ''}
                      {tx.amount.toLocaleString()}
                    </span>
                    {tx.balance_after != null && (
                      <span className="diamond-wallet-modal__tx-bal">
                        Bal: {tx.balance_after.toLocaleString()}
                      </span>
                    )}
                    <span className="diamond-wallet-modal__tx-time">
                      {dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                      {dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
