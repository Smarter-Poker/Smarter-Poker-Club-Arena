/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER WALLET PAGE / #SMARTERCASINOREALISM
 *
 *  One rendered vault room; every figure on it is live DOM text off the ledger.
 *
 *  Dan 2026-09-04: "this entire wallet page needs a full audit, enhancement,
 *  improvement, bug hunt and optimization ... make sure that wallets can send
 *  and receive, as well as earn."
 *
 *  What this page does now, and where each thing actually goes:
 *    WALLETS  Diamonds, Player, Promo and Business plates (rendered art, live
 *             bays) - useWalletStore -> WalletService / DiamondService.
 *    SEND     Diamonds to an accepted friend: POST /api/store/diamond-transfer
 *             (World Hub, server-authoritative, friend + age + velocity gated).
 *             Chips between your own wallets: rpc fn_wallet_type_transfer.
 *    RECEIVE  Your player number and profile link, plus every credit that
 *             landed in your diamond ledger (`diamond_transactions`, RLS-scoped
 *             to the caller).
 *    EARN     Daily login claim: POST /api/rewards/daily-login, read through
 *             GET /api/rewards/progress. Lifetime earned / spent from the
 *             diamond ledger. Doors to Rakeback, Challenges, Bonuses, Promotions.
 *    LEDGER   TransactionHistory (wallet_transactions) + chip_ledger audit.
 *
 *  Add Chips / Cash Out are CLUB operations (an agent or the club cashier moves
 *  chips), so with a club in context they open that club's cashier. Without one
 *  they open the sheet that says so. They no longer end in a dead endpoint.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { useWalletStore } from '../stores/useWalletStore';
import { useUserStore } from '../stores/useUserStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import { useToast } from '../components/common/Toast';
import { confirmDialog } from '../components/common/confirmDialog';
import { TransactionHistory } from '../components/wallet/TransactionHistory';
import DepositWithdrawModal from '../components/wallet/DepositWithdrawModal';
import DisputeSubmitModal from '../components/wallet/DisputeSubmitModal';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import ChipStatement from '../components/wallet/ChipStatement';
import { DiamondService } from '../services/DiamondService';
import { storeFetch } from './marketplace/marketplaceShared';
import { diamondTxLabel } from '../components/wallet/DiamondWalletModal';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { formatPopupText } from '../utils/popupStyle';
import { mediaUrl } from '../utils/mediaBase';
import { reportError } from '../utils/errorReporter';
import { useRealtimeFinancials } from '../hooks/useRealtimeFinancials';
import './PlayerWalletPage.css';

type WalletTab = 'overview' | 'send' | 'receive' | 'earn' | 'history';
type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

/** One list, module scope, used by both the tablist and its keyboard handler. */
const WALLET_TABS: WalletTab[] = ['overview', 'send', 'receive', 'earn', 'history'];
const TAB_LABEL: Record<WalletTab, string> = {
  overview: 'Wallets',
  send: 'Send',
  receive: 'Receive',
  earn: 'Earn',
  history: 'Ledger',
};

const HERO_ART = mediaUrl('images/wallet/value-vault-hero-v1.webp');
const PLATE_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons/wallets/square`;
const PLATE = {
  DIAMONDS: `${PLATE_ROOT}/wallet-diamonds-square-v1.webp`,
  PLAYER: `${PLATE_ROOT}/wallet-player-wallet-square-v1.webp`,
  PROMO: `${PLATE_ROOT}/wallet-promo-wallet-square-v1.webp`,
  BUSINESS: `${PLATE_ROOT}/wallet-agent-wallet-square-v1.webp`,
} as const;

/** The World Hub transfer route refuses anything under this. Mirror it here. */
const MIN_DIAMOND_SEND = 10;

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

const fmtNum = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER HOOK
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
 *
 *  3. (2026-09-04) REDUCED MOTION IS A SETTING, NOT A SUGGESTION. A player who
 *     asked the OS for no motion got 800ms of rolling digits on every balance
 *     change. The counter now snaps for them.
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
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!Number.isFinite(delta) || delta === 0 || reduceMotion) {
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
// WALLET CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const WALLET_CONFIG: Record<
  WalletType,
  { icon: string; label: string; description: string; cssClass: string; plate: string }
> = {
  PLAYER: {
    icon: '♠',
    label: 'Player',
    description: 'Table Buy-Ins And Gameplay',
    cssClass: 'player',
    plate: PLATE.PLAYER,
  },
  PROMO: {
    icon: '★',
    label: 'Promo',
    description: 'Bonuses And Rewards',
    cssClass: 'promo',
    plate: PLATE.PROMO,
  },
  BUSINESS: {
    icon: '◈',
    label: 'Business',
    description: 'Commissions And Settlements',
    cssClass: 'business',
    plate: PLATE.BUSINESS,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET PLATE - rendered plate art, live figures in the bay
// ═══════════════════════════════════════════════════════════════════════════════

function WalletPlate({
  type,
  available,
  locked,
  total,
  totalOfAll,
}: {
  type: WalletType;
  available: number;
  locked: number;
  total: number;
  totalOfAll: number;
}) {
  const config = WALLET_CONFIG[type];
  const animatedAvail = useAnimatedNumber(available);
  const animatedLocked = useAnimatedNumber(locked);
  const animatedTotal = useAnimatedNumber(total);
  const sharePct = totalOfAll > 0 ? Math.min((total / totalOfAll) * 100, 100) : 0;

  return (
    <article
      className={`wallet-plate ${config.cssClass}`}
      aria-label={`${config.label} Wallet: ${fmtNum(available)} Available, ${fmtNum(locked)} Locked, ${fmtNum(total)} Total`}
    >
      <img
        className="wallet-plate__art"
        src={config.plate}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
      />
      <div className="wallet-plate__bay">
        <div className="wallet-plate__row">
          <div className="wallet-plate__stat">
            <span className="wallet-plate__value available">{fmtNum(animatedAvail)}</span>
            <span className="wallet-plate__label">Available</span>
          </div>
          <div className="wallet-plate__stat">
            <span className="wallet-plate__value locked">{fmtNum(animatedLocked)}</span>
            <span className="wallet-plate__label">Locked</span>
          </div>
          <div className="wallet-plate__stat">
            <span className="wallet-plate__value total">{fmtNum(animatedTotal)}</span>
            <span className="wallet-plate__label">Total</span>
          </div>
        </div>
        <div className="wallet-plate__meter" aria-hidden="true">
          <div className="wallet-plate__meter-fill" style={{ width: `${sharePct}%` }} />
        </div>
        <div className="wallet-plate__desc">{config.description}</div>
      </div>
    </article>
  );
}

function DiamondPlate({ diamonds, onBuy }: { diamonds: number; onBuy: () => void }) {
  const animated = useAnimatedNumber(diamonds);
  return (
    <article className="wallet-plate diamonds" aria-label={`Diamonds: ${fmtNum(diamonds)}`}>
      <img
        className="wallet-plate__art"
        src={PLATE.DIAMONDS}
        alt=""
        aria-hidden="true"
        decoding="async"
      />
      <div className="wallet-plate__bay">
        <div className="wallet-plate__row">
          <div className="wallet-plate__stat wide">
            <span className="wallet-plate__value diamond">{fmtNum(animated)}</span>
            <span className="wallet-plate__label">Diamonds On Hand</span>
          </div>
          <button type="button" className="wallet-plate__cta" onClick={onBuy}>
            Buy Diamonds
          </button>
        </div>
        <div className="wallet-plate__desc">
          Spend On VIP, Table Perks, Throwables And Club Shop Items. Send To Friends From The Send
          Tab.
        </div>
      </div>
    </article>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES USED BY THE SEND / RECEIVE / EARN PANES
// ═══════════════════════════════════════════════════════════════════════════════

interface FriendOption {
  id: string;
  name: string;
}

interface IncomingRow {
  id: string;
  label: string;
  description: string;
  amount: number;
  createdAt: string;
}

interface RewardsProgress {
  earnedToday: number;
  dailyCap: number;
  dailyRemaining: number;
  loginStreak: number;
  multiplier: number;
  isVip: boolean;
}

interface DailyClaimResponse {
  success: boolean;
  claimed?: boolean;
  alreadyClaimed?: boolean;
  awarded?: number;
  diamondsAwarded?: number;
  streak?: number;
  message?: string;
  reason?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function PlayerWalletPage() {
  useRealtimeFinancials();
  useEffect(() => {
    document.title = 'Wallet | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const { balances, diamonds, loadBalances, loadDiamonds, internalTransfer } = useWalletStore();
  /**
   * A dispute is filed AGAINST A CLUB, and this page is not club-scoped, so
   * the Dispute button used to open a modal hard-wired to `clubId=""`.
   * DisputeService writes that straight through to a uuid column, so every
   * dispute filed from the wallet page failed with 22P02 (invalid input syntax
   * for type uuid) and the player was told "Failed To Submit Dispute. Please
   * Try Again" for something that could never succeed however many times they
   * tried. The club the player last entered is the honest context; with no club
   * at all there is nothing to dispute against, and the button says so instead
   * of opening. The same context decides where Add Chips and Cash Out go.
   */
  const currentClubId = useUserStore((s) => s.currentClubId);
  const playerNumber = useUserStore((s) => s.user?.player_number ?? null);
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

  // ── Send diamonds ──
  const [friends, setFriends] = useState<FriendOption[] | null>(null);
  const [friendsError, setFriendsError] = useState(false);
  const [recipientId, setRecipientId] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);

  // ── Receive ──
  const [incoming, setIncoming] = useState<IncomingRow[] | null>(null);
  const [incomingError, setIncomingError] = useState(false);
  const [copied, setCopied] = useState<'id' | 'link' | null>(null);

  // ── Earn ──
  const [progress, setProgress] = useState<RewardsProgress | null>(null);
  const [progressError, setProgressError] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimedToday, setClaimedToday] = useState(false);
  const [lifetime, setLifetime] = useState<{
    lifetimeEarned: number;
    lifetimeSpent: number;
  } | null>(null);

  // Auto-dismiss messages after 8s
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      if (isMounted.current) setMessage(null);
    }, 8000);
    return () => clearTimeout(t);
  }, [message, isMounted]);

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
      // Refresh when new chip_ledger transactions arrive. (The `as any` cast
      // this listener once needed is gone: 'TRANSACTION_LOGGED' is in the
      // BusEventType union now.)
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

  // ── Keyboard navigation for tabs (Arrow Left/Right, Home, End) ──
  // WALLET_TABS is module scope: it was rebuilt on every render and closed over
  // by a useCallback that did not list it, which is a stale-closure trap left
  // armed for whoever adds a fourth tab.
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const idx = WALLET_TABS.indexOf(activeTab);
      const next =
        e.key === 'Home'
          ? WALLET_TABS[0]
          : e.key === 'End'
            ? WALLET_TABS[WALLET_TABS.length - 1]
            : e.key === 'ArrowRight'
              ? WALLET_TABS[(idx + 1) % WALLET_TABS.length]
              : WALLET_TABS[(idx - 1 + WALLET_TABS.length) % WALLET_TABS.length];
      setActiveTab(next);
      document.getElementById(`wallet-tab-${next}`)?.focus();
    },
    [activeTab]
  );

  const totalBalance = balances.BUSINESS.total + balances.PLAYER.total + balances.PROMO.total;
  const animatedTotal = useAnimatedNumber(totalBalance, 1000);
  const animatedDiamonds = useAnimatedNumber(diamonds, 800);

  // ═══════════════════ INTERNAL CHIP TRANSFER (own wallets) ═══════════════════
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

  // ═══════════════════ SEND DIAMONDS TO A FRIEND ═══════════════════
  /*
   * The transfer route only pays ACCEPTED friends, so the recipient picker is
   * the friend list and nothing else. A free-text id box would let a player
   * type a stranger's id, press Send, and be refused with a 403 they could
   * not act on. Both directions of `friendships` count as a friendship.
   */
  const loadFriends = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [{ data: out, error: e1 }, { data: inn, error: e2 }] = await Promise.all([
        supabase
          .from('friendships')
          .select('friend_id')
          .eq('user_id', user.id)
          .eq('status', 'accepted')
          .limit(500),
        supabase
          .from('friendships')
          .select('user_id')
          .eq('friend_id', user.id)
          .eq('status', 'accepted')
          .limit(500),
      ]);
      if (e1 || e2) throw e1 || e2;
      const ids = Array.from(
        new Set([
          ...(out || []).map((r) => r.friend_id as string),
          ...(inn || []).map((r) => r.user_id as string),
        ])
      ).filter((id) => id && id !== user.id);
      if (ids.length === 0) {
        if (isMounted.current) {
          setFriends([]);
          setFriendsError(false);
        }
        return;
      }
      const { data: profiles, error: e3 } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, player_number`)
        .in('id', ids);
      if (e3) throw e3;
      const options: FriendOption[] = (profiles || [])
        .map((p) => {
          const row = p as unknown as Record<string, unknown> & {
            id: string;
            player_number?: number;
          };
          const name = playerDisplayName(row as never) || 'Player';
          return {
            id: row.id,
            name: row.player_number ? `${name} (#${row.player_number})` : name,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (isMounted.current) {
        setFriends(options);
        setFriendsError(false);
      }
    } catch (err) {
      reportError(err, 'PlayerWalletPage.loadFriends');
      if (isMounted.current) {
        setFriends([]);
        setFriendsError(true);
      }
    }
  }, [user?.id, isMounted]);

  useEffect(() => {
    if (activeTab === 'send' && friends === null) void loadFriends();
  }, [activeTab, friends, loadFriends]);

  const handleSendDiamonds = async () => {
    if (!user?.id) return;
    if (sendInFlightRef.current) return;
    const amount = Math.floor(Number(sendAmount));
    if (!recipientId) {
      toast.error('Choose A Friend To Send To');
      return;
    }
    if (!Number.isFinite(amount) || amount < MIN_DIAMOND_SEND) {
      toast.error(`Minimum Send Is ${MIN_DIAMOND_SEND} Diamonds`);
      return;
    }
    if (amount > diamonds) {
      toast.error(`You Only Have ${fmtNum(diamonds)} Diamonds`);
      return;
    }
    const friend = friends?.find((f) => f.id === recipientId);
    const ok = await confirmDialog({
      title: 'Send Diamonds',
      message: `Send ${fmtNum(amount)} Diamonds To ${friend?.name || 'This Friend'}? Diamond Gifts Cannot Be Reversed.`,
      confirmText: 'Send',
      variant: 'default',
    });
    if (!ok) return;
    sendInFlightRef.current = true;
    setIsSending(true);
    try {
      const data = await storeFetch<{
        success: true;
        transferred: number;
        newBalance?: number;
        recipientName?: string;
      }>('/api/store/diamond-transfer', { body: { recipientId, amount } });
      toast.success(
        `Sent ${fmtNum(data.transferred || amount)} Diamonds To ${data.recipientName || friend?.name || 'Your Friend'}`
      );
      if (isMounted.current) setSendAmount('');
      loadDiamonds(user.id, { force: true });
      masterBus.emit('BALANCE_UPDATED', { source: 'diamond_gift_sent', userId: user.id });
      if (typeof data.newBalance === 'number') {
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: data.newBalance,
          delta: -amount,
          source: 'diamond_gift_sent',
        });
      }
    } catch (err) {
      // storeFetch throws with the server's own sentence (friend-only, account
      // age, cooldown, 30-day cap). That sentence IS the explanation; show it.
      const text =
        err instanceof Error && err.message ? err.message : 'Send Failed. Please Try Again';
      toast.error(formatPopupText(text));
    } finally {
      sendInFlightRef.current = false;
      if (isMounted.current) setIsSending(false);
    }
  };

  // ═══════════════════ RECEIVE ═══════════════════
  const loadIncoming = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from('diamond_transactions')
        /* `type` AND `transaction_type`: the older rows carry their kind in
           `type` (signup_bonus, reconciliation), the newer in
           `transaction_type`. Reading one column blanks half the ledger. */
        .select('id, type, transaction_type, amount, description, created_at')
        .eq('user_id', user.id)
        .gt('amount', 0)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      const rows: IncomingRow[] = (data || []).map((tx) => {
        const kind = (tx.transaction_type as string | null) || (tx.type as string | null);
        return {
          id: String(tx.id),
          label: diamondTxLabel(kind),
          description: String(tx.description || ''),
          amount: Number(tx.amount) || 0,
          createdAt: String(tx.created_at),
        };
      });
      if (isMounted.current) {
        setIncoming(rows);
        setIncomingError(false);
      }
    } catch (err) {
      reportError(err, 'PlayerWalletPage.loadIncoming');
      if (isMounted.current) {
        setIncoming([]);
        setIncomingError(true);
      }
    }
  }, [user?.id, isMounted]);

  useEffect(() => {
    if (activeTab === 'receive' && incoming === null) void loadIncoming();
  }, [activeTab, incoming, loadIncoming]);

  // A credit that lands while the pane is open should appear without a reload.
  useEffect(() => {
    if (activeTab !== 'receive' || !user?.id) return;
    return masterBus.subscribeDebounced('BALANCE_UPDATED', () => void loadIncoming(), 1500);
  }, [activeTab, user?.id, loadIncoming]);

  const profileLink = useMemo(() => {
    if (!user?.id) return '';
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    return `${origin}${base}/profile/${user.id}`;
  }, [user?.id]);

  const copyText = async (text: string, which: 'id' | 'link') => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setCopied(which);
      toast.success(which === 'id' ? 'Player ID Copied' : 'Profile Link Copied');
      setTimeout(() => {
        if (isMounted.current) setCopied(null);
      }, 2000);
    } catch {
      // No clipboard permission (older WebViews, some in-app browsers). The
      // text is on screen and selectable; say so instead of failing silently.
      toast.info('Select The Text To Copy It');
    }
  };

  // ═══════════════════ EARN ═══════════════════
  const loadProgress = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await storeFetch<RewardsProgress & { success: boolean }>(
        '/api/rewards/progress'
      );
      if (isMounted.current) {
        setProgress({
          earnedToday: Number(data.earnedToday) || 0,
          dailyCap: Number(data.dailyCap) || 0,
          dailyRemaining: Number(data.dailyRemaining) || 0,
          loginStreak: Number(data.loginStreak) || 0,
          multiplier: Number(data.multiplier) || 1,
          isVip: Boolean(data.isVip),
        });
        setProgressError(false);
      }
    } catch (err) {
      reportError(err, 'PlayerWalletPage.loadProgress');
      if (isMounted.current) setProgressError(true);
    }
    DiamondService.getLifetimeStats(user.id).then((stats) => {
      if (isMounted.current) setLifetime(stats);
    });
  }, [user?.id, isMounted]);

  useEffect(() => {
    if (activeTab === 'earn' && progress === null && !progressError) void loadProgress();
  }, [activeTab, progress, progressError, loadProgress]);

  const handleClaimDaily = async () => {
    if (!user?.id || claiming) return;
    setClaiming(true);
    try {
      /* The route answers 200 for "already claimed today" with success:true
         and alreadyClaimed:true, and 200 success:false for "not eligible" /
         "temporarily unavailable". storeFetch throws on success:false, so the
         soft outcomes arrive here and the hard ones arrive in the catch. */
      const data = await storeFetch<DailyClaimResponse>('/api/rewards/daily-login', {
        body: {},
      });
      if (data.claimed) {
        toast.success(
          `+${fmtNum(data.awarded ?? data.diamondsAwarded ?? 0)} Diamonds Claimed${data.streak && data.streak > 1 ? ` (${data.streak}-Day Streak)` : ''}`
        );
        setClaimedToday(true);
        loadDiamonds(user.id, { force: true });
        masterBus.emit('BALANCE_UPDATED', { source: 'daily_login', userId: user.id });
      } else if (data.alreadyClaimed) {
        toast.info('Today Is Already Claimed. Come Back Tomorrow');
        setClaimedToday(true);
      } else {
        toast.info(formatPopupText(data.message || 'Nothing To Claim Right Now'));
      }
      void loadProgress();
    } catch (err) {
      const text =
        err instanceof Error && err.message ? err.message : 'Claim Failed. Please Try Again';
      toast.error(formatPopupText(text));
    } finally {
      if (isMounted.current) setClaiming(false);
    }
  };

  // ═══════════════════ ADD CHIPS / CASH OUT ═══════════════════
  /*
   * Chips enter and leave a player's wallet through a CLUB: an agent or the
   * club cashier moves them. With a club in context the honest destination is
   * that club's cashier page, which performs the operation. Without one, the
   * sheet explains who to ask. Neither path ends in the dead FUNDING_ENDPOINT.
   */
  const goAddChips = () => {
    if (currentClubId) navigate(`/clubs/${currentClubId}/cashier`);
    else setShowDepositModal(true);
  };
  const goCashOut = () => {
    if (currentClubId) navigate(`/clubs/${currentClubId}/cashier`);
    else setShowWithdrawModal(true);
  };
  const goBuyDiamonds = () => navigate('/marketplace?tab=diamonds');

  const escrow = balances.PLAYER.locked;

  return (
    <div className="wallet-page" data-arena-surface="wallet">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Wallet"
        title="Your Value Vault"
        description="One Secure Command Surface For Playable Chips, Protected Balances, Club Earnings, Promotional Value, And Diamonds. Every Figure Below Remains Connected To The Live Wallet Ledger."
        artPath="images/wallet/value-vault-hero-v1.webp"
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

      {/* ═══════════ VAULT HERO - rendered room, live console ═══════════ */}
      <section className="vault-hero" aria-labelledby="vault-hero-title">
        <img
          className="vault-hero__art"
          src={HERO_ART}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          decoding="async"
        />
        <div className="vault-hero__hardware" aria-hidden="true" />
        <div className="vault-hero__console">
          <p className="vault-hero__eyebrow">Value Vault // Live Ledger</p>
          {/* "Total Balance" was a lie of omission. This figure is BUSINESS +
              PLAYER + PROMO, and only the PLAYER wallet buys into a game: an
              agent with 40,000 in commissions and 200 in chips read "Total
              Balance 40,200" and then could not sit down for 400. Different
              accounts do not become one balance by being summed, so the label
              says what the sum IS and the playable figure is stated beside it. */}
          <h2 id="vault-hero-title" className="vault-hero__label">
            All Wallets Combined
          </h2>
          <div className="vault-hero__figure" aria-live="polite">
            {animatedTotal.toLocaleString()}
          </div>
          <dl className="vault-hero__meta">
            <div className="vault-hero__meta-item live">
              <dt>Playable Now</dt>
              <dd>{balances.PLAYER.available.toLocaleString()}</dd>
            </div>
            <div className="vault-hero__meta-item diamond">
              <dt>Diamonds</dt>
              {/* A READOUT, not a control. This carried role="button" and
                  tabIndex={0} with no handler; the Buy Diamonds plate below is
                  the control. */}
              <dd className="hero-diamonds">
                <span className="diamond-glyph" aria-hidden="true">
                  ◆
                </span>
                <span aria-label={`${animatedDiamonds.toLocaleString()} Diamonds`}>
                  {animatedDiamonds.toLocaleString()}
                </span>
              </dd>
            </div>
            {escrow > 0 && (
              <div className="vault-hero__meta-item escrow">
                <dt>In Escrow</dt>
                <dd>{escrow.toLocaleString()} Chips Secured At The Table</dd>
              </div>
            )}
          </dl>

          <div className="vault-hero__actions" role="group" aria-label="Wallet Actions">
            <button type="button" className="vault-btn primary" onClick={goAddChips}>
              + Add Chips
            </button>
            <button type="button" className="vault-btn" onClick={goCashOut}>
              Cash Out
            </button>
            <button type="button" className="vault-btn" onClick={() => setActiveTab('send')}>
              Send
            </button>
            <button type="button" className="vault-btn" onClick={() => setActiveTab('receive')}>
              Receive
            </button>
            <button type="button" className="vault-btn" onClick={() => setActiveTab('earn')}>
              Earn
            </button>
            <button
              type="button"
              className="vault-btn ghost"
              onClick={() => navigate('/transactions')}
            >
              Full History
            </button>
            <button
              type="button"
              className="vault-btn ghost"
              onClick={() => setShowDisputeModal(true)}
              disabled={!currentClubId}
              title={
                currentClubId ? 'Raise A Dispute' : 'Enter A Club First To Raise A Dispute There'
              }
            >
              Dispute
            </button>
          </div>
        </div>
      </section>

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
            type="button"
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
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      {/* ═══════════ TAB CONTENT ═══════════ */}
      {/* One panel element, re-identified as the active tab changes, is the
          correct shape for a tablist that renders only the selected pane. */}
      <div
        className="wallet-content"
        id={`wallet-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`wallet-tab-${activeTab}`}
      >
        {/* WALLETS */}
        {activeTab === 'overview' && (
          <div className="wallet-plates">
            <DiamondPlate diamonds={diamonds} onBuy={goBuyDiamonds} />
            {(Object.keys(WALLET_CONFIG) as WalletType[]).map((type) => (
              <WalletPlate
                key={type}
                type={type}
                available={balances[type].available}
                locked={balances[type].locked}
                total={balances[type].total}
                totalOfAll={totalBalance}
              />
            ))}
          </div>
        )}

        {/* SEND */}
        {activeTab === 'send' && (
          <div className="wallet-grid">
            <section className="vault-panel" aria-labelledby="send-diamonds-title">
              <h3 id="send-diamonds-title" className="vault-panel__title">
                Send Diamonds To A Friend
              </h3>
              <p className="vault-panel__sub">
                Diamonds Move Instantly To Any Accepted Friend. Minimum {MIN_DIAMOND_SEND}. Gifts
                Cannot Be Reversed.
              </p>
              <div className="vault-form">
                <label className="vault-field">
                  <span className="vault-field__label">Recipient</span>
                  <select
                    className="vault-select"
                    value={recipientId}
                    onChange={(e) => setRecipientId(e.target.value)}
                    disabled={friends === null || friends.length === 0}
                  >
                    <option value="">
                      {friends === null
                        ? 'Loading Friends...'
                        : friends.length === 0
                          ? friendsError
                            ? 'Could Not Load Friends'
                            : 'No Accepted Friends Yet'
                          : 'Choose A Friend'}
                    </option>
                    {(friends || []).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="vault-field">
                  <span className="vault-field__label">Amount (Diamonds)</span>
                  <input
                    className="vault-input"
                    type="number"
                    inputMode="numeric"
                    min={MIN_DIAMOND_SEND}
                    step={1}
                    placeholder={`${MIN_DIAMOND_SEND}`}
                    value={sendAmount}
                    onChange={(e) => setSendAmount(e.target.value)}
                  />
                </label>
                <div className="vault-form__row">
                  <span className="vault-form__hint">Available: {fmtNum(diamonds)} Diamonds</span>
                  <button
                    type="button"
                    className="vault-btn primary"
                    onClick={handleSendDiamonds}
                    disabled={isSending || !recipientId || !sendAmount}
                  >
                    {isSending ? 'Sending...' : 'Send Diamonds'}
                  </button>
                </div>
                {friends !== null && friends.length === 0 && !friendsError && (
                  <p className="vault-form__hint">
                    Add Friends From The{' '}
                    <button
                      type="button"
                      className="vault-link"
                      onClick={() => navigate('/friends')}
                    >
                      Friends Page
                    </button>{' '}
                    To Send Them Diamonds.
                  </p>
                )}
                {friendsError && (
                  <p className="vault-form__hint" role="alert">
                    Your Friend List Could Not Be Loaded.{' '}
                    <button type="button" className="vault-link" onClick={() => void loadFriends()}>
                      Retry
                    </button>
                  </p>
                )}
              </div>
            </section>

            <section className="vault-panel" aria-labelledby="internal-transfer-title">
              <h3 id="internal-transfer-title" className="vault-panel__title">
                Move Chips Between My Wallets
              </h3>
              <p className="vault-panel__sub">
                Business, Player And Promo Are Separate Accounts. Move Funds Between Them Instantly.
              </p>
              <div className="vault-form">
                <label className="vault-field">
                  <span className="vault-field__label">From</span>
                  <select
                    className="vault-select"
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
                </label>
                <label className="vault-field">
                  <span className="vault-field__label">To</span>
                  <select
                    className="vault-select"
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
                </label>
                <label className="vault-field">
                  <span className="vault-field__label">Amount</span>
                  <input
                    className="vault-input"
                    type="number"
                    placeholder="0.00"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    aria-label="Transfer Amount"
                    inputMode="decimal"
                    min="0"
                  />
                </label>
                {message && (
                  <div
                    className={`message ${message.type}`}
                    role={message.type === 'error' ? 'alert' : 'status'}
                  >
                    {message.text}
                  </div>
                )}
                <div className="vault-form__row">
                  <span className="vault-form__hint">
                    Available In {WALLET_CONFIG[transferFrom].label}:{' '}
                    {balances[transferFrom].available.toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="vault-btn primary"
                    onClick={handleTransfer}
                    disabled={isTransferring || !transferAmount}
                  >
                    {isTransferring ? 'Transferring...' : 'Transfer'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* RECEIVE */}
        {activeTab === 'receive' && user?.id && (
          <div className="wallet-grid">
            <section className="vault-panel" aria-labelledby="receive-title">
              <h3 id="receive-title" className="vault-panel__title">
                Receive Diamonds And Chips
              </h3>
              <p className="vault-panel__sub">
                Friends Send Diamonds From Their Wallet. Chips Arrive From Your Club Cashier Or
                Agent.
              </p>
              <dl className="receive-ids">
                <div className="receive-ids__row">
                  <dt>Player Number</dt>
                  <dd>
                    <span className="receive-ids__value">
                      {playerNumber ? `#${playerNumber}` : 'Assigned After First Login'}
                    </span>
                  </dd>
                </div>
                <div className="receive-ids__row">
                  <dt>Player ID</dt>
                  <dd>
                    <code className="receive-ids__value mono">{user.id}</code>
                    <button
                      type="button"
                      className="vault-btn small"
                      onClick={() => void copyText(user.id, 'id')}
                      aria-label="Copy Player ID"
                    >
                      {copied === 'id' ? 'Copied' : 'Copy'}
                    </button>
                  </dd>
                </div>
                <div className="receive-ids__row">
                  <dt>Profile Link</dt>
                  <dd>
                    <code className="receive-ids__value mono">{profileLink}</code>
                    <button
                      type="button"
                      className="vault-btn small"
                      onClick={() => void copyText(profileLink, 'link')}
                      aria-label="Copy Profile Link"
                    >
                      {copied === 'link' ? 'Copied' : 'Copy'}
                    </button>
                  </dd>
                </div>
              </dl>
              <div className="vault-form__row">
                <span className="vault-form__hint">
                  Share Your Profile So Friends Can Add You, Then Send.
                </span>
                <button type="button" className="vault-btn" onClick={() => navigate('/friends')}>
                  Manage Friends
                </button>
              </div>
            </section>

            <section className="vault-panel" aria-labelledby="incoming-title">
              <h3 id="incoming-title" className="vault-panel__title">
                Diamonds Received
              </h3>
              <p className="vault-panel__sub">
                Every Credit That Landed In Your Diamond Ledger, Newest First.
              </p>
              {incoming === null && <div className="vault-empty">Loading Your Ledger...</div>}
              {incoming !== null && incomingError && (
                <div className="vault-empty" role="alert">
                  Could Not Load Incoming Diamonds.{' '}
                  <button type="button" className="vault-link" onClick={() => void loadIncoming()}>
                    Retry
                  </button>
                </div>
              )}
              {incoming !== null && !incomingError && incoming.length === 0 && (
                <div className="vault-empty">
                  No Diamonds Received Yet. Claim Your Daily Login From The Earn Tab.
                </div>
              )}
              {incoming !== null && incoming.length > 0 && (
                <ul className="incoming-list">
                  {incoming.map((row) => (
                    <li key={row.id} className="incoming-row">
                      <div className="incoming-row__body">
                        <span className="incoming-row__label">{formatPopupText(row.label)}</span>
                        <span className="incoming-row__desc">
                          {formatPopupText(row.description || row.label)}
                        </span>
                      </div>
                      <div className="incoming-row__side">
                        <span className="incoming-row__amount">+{fmtNum(row.amount)}</span>
                        <time className="incoming-row__time" dateTime={row.createdAt}>
                          {new Date(row.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {/* EARN */}
        {activeTab === 'earn' && (
          <div className="wallet-grid">
            <section className="vault-panel accent" aria-labelledby="daily-title">
              <h3 id="daily-title" className="vault-panel__title">
                Daily Login Reward
              </h3>
              <p className="vault-panel__sub">
                Claim Once A Day. The Payout Climbs With Your Streak, Up To 25 Diamonds.
              </p>
              <dl className="earn-stats">
                <div className="earn-stat">
                  <dt>Streak</dt>
                  <dd>
                    {progress
                      ? `${fmtNum(progress.loginStreak)} Days`
                      : progressError
                        ? 'Unavailable'
                        : 'Checking'}
                  </dd>
                </div>
                <div className="earn-stat">
                  <dt>Earned Today</dt>
                  <dd>
                    {progress
                      ? `${fmtNum(progress.earnedToday)} / ${fmtNum(progress.dailyCap)}`
                      : progressError
                        ? 'Unavailable'
                        : 'Checking'}
                  </dd>
                </div>
                <div className="earn-stat">
                  <dt>Multiplier</dt>
                  <dd>
                    {progress
                      ? `${progress.multiplier}x${progress.isVip ? ' VIP' : ''}`
                      : progressError
                        ? 'Unavailable'
                        : 'Checking'}
                  </dd>
                </div>
              </dl>
              {progress && progress.dailyCap > 0 && (
                <div
                  className="earn-meter"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.dailyCap}
                  aria-valuenow={Math.min(progress.earnedToday, progress.dailyCap)}
                  aria-label="Diamonds Earned Today"
                >
                  <div
                    className="earn-meter__fill"
                    style={{
                      width: `${Math.min(100, (progress.earnedToday / progress.dailyCap) * 100)}%`,
                    }}
                  />
                </div>
              )}
              <div className="vault-form__row">
                <span className="vault-form__hint">
                  {progressError ? (
                    <>
                      Reward Status Is Unavailable.{' '}
                      <button
                        type="button"
                        className="vault-link"
                        onClick={() => {
                          setProgressError(false);
                          void loadProgress();
                        }}
                      >
                        Retry
                      </button>
                    </>
                  ) : (
                    'Diamonds Land In Your Wallet Instantly.'
                  )}
                </span>
                <button
                  type="button"
                  className="vault-btn primary"
                  onClick={handleClaimDaily}
                  disabled={claiming || claimedToday}
                >
                  {claiming
                    ? 'Claiming...'
                    : claimedToday
                      ? 'Claimed Today'
                      : 'Claim Daily Diamonds'}
                </button>
              </div>
            </section>

            <section className="vault-panel" aria-labelledby="lifetime-title">
              <h3 id="lifetime-title" className="vault-panel__title">
                Lifetime Diamonds
              </h3>
              <p className="vault-panel__sub">
                From Your Diamond Ledger. Earned Is Every Credit; Spent Is Every Debit.
              </p>
              <dl className="earn-stats">
                <div className="earn-stat">
                  <dt>Earned</dt>
                  <dd className="positive">
                    {lifetime ? fmtNum(lifetime.lifetimeEarned) : 'Checking'}
                  </dd>
                </div>
                <div className="earn-stat">
                  <dt>Spent</dt>
                  <dd>{lifetime ? fmtNum(lifetime.lifetimeSpent) : 'Checking'}</dd>
                </div>
                <div className="earn-stat">
                  <dt>On Hand</dt>
                  <dd className="diamond">{fmtNum(diamonds)}</dd>
                </div>
              </dl>
            </section>

            <section className="vault-panel span2" aria-labelledby="earn-more-title">
              <h3 id="earn-more-title" className="vault-panel__title">
                More Ways To Earn
              </h3>
              <div className="earn-doors">
                <button type="button" className="earn-door" onClick={() => navigate('/rakeback')}>
                  <span className="earn-door__title">Rakeback</span>
                  <span className="earn-door__sub">Chips Back On Every Raked Hand You Play.</span>
                </button>
                <button type="button" className="earn-door" onClick={() => navigate('/challenges')}>
                  <span className="earn-door__title">Daily Challenges</span>
                  <span className="earn-door__sub">Complete Missions For Diamond Payouts.</span>
                </button>
                <button type="button" className="earn-door" onClick={() => navigate('/bonuses')}>
                  <span className="earn-door__title">Bonuses</span>
                  <span className="earn-door__sub">
                    Your Daily Club Arena Bonus And Club Promotions.
                  </span>
                </button>
                <button type="button" className="earn-door" onClick={() => navigate('/promotions')}>
                  <span className="earn-door__title">Promotions</span>
                  <span className="earn-door__sub">Club Promos, Leaderboards And Prize Pools.</span>
                </button>
                <button
                  type="button"
                  className="earn-door"
                  onClick={() => navigate('/achievements')}
                >
                  <span className="earn-door__title">Achievements</span>
                  <span className="earn-door__sub">Milestones That Pay Out When You Hit Them.</span>
                </button>
                <button type="button" className="earn-door" onClick={() => navigate('/vip')}>
                  <span className="earn-door__title">VIP Bonuses</span>
                  <span className="earn-door__sub">
                    Daily And Monthly Diamond Bonuses For Members.
                  </span>
                </button>
              </div>
            </section>
          </div>
        )}

        {/* LEDGER */}
        {activeTab === 'history' && user?.id && (
          <div className="wallet-grid single">
            <section className="vault-panel" aria-labelledby="ledger-title">
              <h3 id="ledger-title" className="vault-panel__title">
                Wallet Ledger
              </h3>
              <TransactionHistory walletId={user.id} limit={50} />
            </section>
            {/* Phase 7 (roadmap 9.5): a statement the player can AUDIT, not a
                feed. The feed this replaces asked chip_ledger for legs where the
                player was performed_by or to_entity_id, so every chip that LEFT
                the player was invisible. The statement shows both directions and
                the nightly reading the balance is checked against. */}
            <section className="vault-panel" aria-labelledby="audit-title">
              <h3 id="audit-title" className="vault-panel__title">
                Chip Statement
              </h3>
              <ChipStatement scope="player" />
            </section>
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
        onComplete={() => user?.id && loadBalances(user.id, { force: true })}
      />
      <DepositWithdrawModal
        isOpen={showWithdrawModal}
        onClose={() => setShowWithdrawModal(false)}
        mode="withdraw"
        userId={user?.id || ''}
        currentBalance={balances.PLAYER.available}
        onComplete={() => user?.id && loadBalances(user.id, { force: true })}
      />
      <DisputeSubmitModal
        isOpen={showDisputeModal && Boolean(currentClubId)}
        onClose={() => setShowDisputeModal(false)}
        clubId={currentClubId ?? ''}
      />
    </div>
  );
}
