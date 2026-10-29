import { usePlayerPreference } from '../../hooks/usePlayerPreference';
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

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import DiamondCustodyBalance from '../arena/DiamondCustodyBalance';
import DiamondWalletTransfer from './DiamondWalletTransfer';
import { useAuthUser } from '../../hooks/useAuthUser';
import { SpadeConsole } from '../console/SpadeConsole';
import { WalletDesk, WalletDeskHeading, WalletDeskRow } from './WalletDesk';
import './WalletDesk.css';
import './DiamondWalletModal.css';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';

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
  /* NO `description`. Phase 6 moved this modal onto `tx.line || label`, and
     the raw description stayed on the select and in this shape with nothing
     reading it. Dropped 2026-09-30 with the column. */
  /** The ledger's own player-facing line (`player_line`, phase 6). */
  line?: string;
  balance_after?: number;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TX TYPE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

/* Only the label is read; the icon and colour every entry used to carry were
   never printed on the console (launch audit D-17). */
const TX_TYPES: Record<string, { label: string }> = {
  purchase: { label: 'Purchase' },
  feature_unlock: { label: 'Feature Unlock' },
  /**
   * Dan 2026-08-23: "when you buy time banks, it actually deducts the diamonds
   * and adds the transaction inside your diamond wallet."
   *
   * It always did both. `deduct_diamonds` debits `profiles.diamonds` and writes
   * the `diamond_transactions` row in the same transaction (confirmed against
   * production: one row, -2,500, "Time banks x500"). What was missing was this
   * line. `deduct_diamonds` stamps `transaction_type` from
   * COALESCE(p_source, p_transaction_type), which for every feature purchase is
   * the literal 'feature_purchase' - a key no wallet map had. The lookup below
   * falls back to `adjustment`, so a diamond spend the player had just made
   * showed up in their own wallet as a grey "Adjustment", indistinguishable
   * from an admin correction. That is what "no transaction in my wallet" was.
   */
  feature_purchase: { label: 'Feature Purchase' },
  /** Same gap, same writer: the diamond helpers also emit this type. */
  chip_purchase: { label: 'Chip Purchase' },
  game_cost: { label: 'Game Entry' },
  arcade_entry: { label: 'Arcade Entry' },
  bonus: { label: 'Bonus' },
  signup_bonus: { label: 'Welcome Bonus' },
  daily_bonus: { label: 'Daily Bonus' },
  daily_login: { label: 'Daily Login' },
  daily_trivia: { label: 'Daily Trivia' },
  streak_reward: { label: 'Streak Reward' },
  vip_reward: { label: 'VIP Reward' },
  vip_stipend: { label: 'VIP Stipend' },
  achievement: { label: 'Achievement' },
  challenge: { label: 'Challenge' },
  tournament_prize: { label: 'Tournament Prize' },
  tournament_refund: { label: 'Tournament Refund' },
  pvp_win: { label: 'PvP Win' },
  pvp_refund: { label: 'PvP Refund' },
  game_reward: { label: 'Game Reward' },
  trivia_reward: { label: 'Trivia Reward' },
  social_post: { label: 'Social Post' },
  follow: { label: 'Follow Reward' },
  reaction: { label: 'Reaction Reward' },
  comment: { label: 'Comment Reward' },
  share: { label: 'Share Reward' },
  referral: { label: 'Referral Bonus' },
  profile_complete: { label: 'Profile Bonus' },
  profile_pic: { label: 'Profile Pic Bonus' },
  video_watch: { label: 'Video Watch' },
  video_favorite: { label: 'Video Favorite' },
  hendonmob_link: { label: 'HendonMob Link' },
  venue_review: { label: 'Venue Review' },
  promo_code: { label: 'Promo Code' },
  refund: { label: 'Refund' },
  adjustment: { label: 'Adjustment' },
  /* `mint` in THIS ledger is a diamond grant (a signup grant, a Lifetime VIP
     monthly benefit), never chips, and the Mint itself is internal (Dan,
     2026-09-05). It used to say "Chip Mint". 2026-10-07. */
  mint: { label: 'Bonus Diamonds' },
  diamond_purchase: { label: 'Diamond Purchase' },
  diamond_deduction: { label: 'Diamond Spent' },
  diamond_reward: { label: 'Diamond Reward' },
  diamond_refund: { label: 'Diamond Refund' },

  /* ── ADDED 2026-09-13, read from the writers and the live ledger ──────────
     THE DIAMOND ARENA IS DIAMONDS ONLY. A buy-in moves diamonds into custody
     (fn_poker_diamond_buyin writes `arena_deposit`), a cash-out moves them
     back (`arena_withdraw`). Neither is a chip and neither is labelled as one.
     The rest are the highest-volume kinds of the last 30 days that had no
     label and fell through to the humaniser (daily_challenge_claim alone is
     55,183 of the 57,000 rows written in that window). */
  arena_deposit: { label: 'Diamond Arena Buy-In' },
  arena_withdraw: { label: 'Diamond Arena Cash-Out' },
  debt_settlement: { label: 'Owed Diamonds Settled' },
  daily_challenge_claim: { label: 'Daily Challenge' },
  daily_challenge_reroll: { label: 'Challenge Reroll' },
  daily_mission_milestone: { label: 'Mission Milestone' },
  plinko_drop: { label: 'Plinko Drop' },
  crash_bet: { label: 'Crash Bet' },
  wheel_spin: { label: 'Wheel Spin' },
  wheel_prize: { label: 'Wheel Prize' },
  transfer: { label: 'Transfer' },

  /* ── ADDED 2026-08-25, from the live `diamond_transactions` table ──────────
     Every type below occurs in production and had NO entry, so all of them fell
     through to the grey "Adjustment" fallback — the exact complaint this file's
     own `feature_purchase` comment was written about, still true for eleven
     more types. `reconciliation` alone is 557 rows: the single largest group in
     the table rendered as if an admin had corrected the player's balance. */
  reconciliation: { label: 'Balance Reconciliation' },
  live_gift_sent: { label: 'Gift Sent' },
  live_gift_received: { label: 'Gift Received' },
  diamond_gift_sent: { label: 'Diamond Gift Sent' },
  diamond_gift_received: { label: 'Diamond Gift Received' },
  diamond_gift_refund: { label: 'Diamond Gift Refund' },
  pvp_stake: { label: 'PvP Stake' },
  training_reward: { label: 'Training Reward' },
  easter_egg: { label: 'Easter Egg' },
  chip_mint: { label: 'Chip Mint' },
  trivia_arcade: { label: 'Trivia Arcade' },
  trivia_run: { label: 'Trivia Run' },
  credit: { label: 'Diamond Credit' },
};

/**
 * A type nobody has taught this map about must still read like English — never
 * the raw enum, never blank, and never a confident "Adjustment" that claims an
 * admin touched the account when nobody did. Underscores become spaces and
 * every word takes a capital, so a `weekly_streak_bonus` added server-side
 * tomorrow reads "Weekly Streak Bonus" from the day it first appears.
 */
export function diamondTxLabel(rawType: string | null | undefined): string {
  const known = rawType ? TX_TYPES[rawType] : undefined;
  if (known) return known.label;
  if (!rawType || !rawType.trim()) return 'Diamond Movement';
  return rawType
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() ? w.toLowerCase() : w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const TX_LIMIT = 50;
/** What can take keyboard focus inside the desk or its sheet. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'earned', label: 'Earned' },
  { value: 'spent', label: 'Spent' },
  { value: 'refund', label: 'Refunds' },
];

/**
 * EARNED / SPENT COME FROM THE SIGN, NOT FROM A LIST. AUDIT 2026-08-25.
 *
 * There used to be a hand-maintained `EARNED_TYPES` array of thirty type names,
 * and "Earned" meant "is in that array". It had to be edited every time the
 * platform learned a new way to give someone a diamond, and it had already
 * fallen behind by eleven types: `live_gift_received`, `diamond_gift_received`,
 * `training_reward`, `easter_egg`, `trivia_run`, `reconciliation` and the rest
 * are all credits, none were listed, and the Earned tab hid every one of them.
 * It also listed `diamond_refund` as earned while the Refunds tab claimed the
 * same rows, and listed `pvp_refund` in neither.
 *
 * A credit is a positive amount. That is a fact about the row rather than a
 * fact about our list, so it cannot go stale.
 */
const isRefund = (type: string) => /refund/i.test(type);

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = usePlayerPreference('diamondWallet.filter', 'all', 'global');
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [historyOwnerId, setHistoryOwnerId] = useState<string | null>(null);
  /* THE HISTORY PAGES (2026-10-17). It read the newest 50 and stopped, so a
     716-row ledger showed "50 Entries" with no way to see the rest. It pages
     now, 50 at a time, on a unique order (created_at, then id) so a page seam
     never serves a row twice or skips one, continuing from the rows on
     screen, and says when the ledger has ended. */
  const historyRequest = useRef(0);
  const historyCursor = useRef<{ owner: string; createdAt: string; id: string } | null>(null);
  const pageInFlight = useRef(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** The desk itself: the focus fallback (the trap wrapper is display: contents). */
  const deskRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /**
   * A TRANSFER IN FLIGHT HOLDS THE DOOR SHUT (launch audit D-13). The
   * transfer's `busy` is lifted here so the backdrop, the corner X, the Close
   * plate and Escape all refuse while send_wallet_diamond_transfer is
   * travelling; the request is persisted and keyed, so nothing could double
   * send, but a sheet that vanished mid-transfer lost the receipt on screen.
   */
  const [transferBusy, setTransferBusy] = useState(false);
  const transferBusyRef = useRef(false);
  const onTransferBusyChange = useCallback((busy: boolean) => {
    transferBusyRef.current = busy;
    setTransferBusy(busy);
  }, []);
  const closeIfIdle = useCallback(() => {
    if (transferBusyRef.current) return;
    onCloseRef.current();
  }, []);
  /** The transfer sheet over the desk (Dan 2026-10-16, the wallet desk). */
  const [sendSheet, setSendSheet] = useState(false);
  const sendSheetRef = useRef(false);
  sendSheetRef.current = sendSheet;
  const closeSendSheet = useCallback(() => {
    if (transferBusyRef.current) return;
    setSendSheet(false);
  }, []);
  const isMounted = useIsMounted();

  const fetchTransactions = useCallback(
    async (append = false) => {
      if (!user?.id || !isOpen) return;
      const cursor = historyCursor.current;
      if (append && (pageInFlight.current || !cursor || cursor.owner !== user.id)) return;
      pageInFlight.current = append;
      setLoadingMore(append);
      setMoreError(false);
      if (!append) {
        historyCursor.current = null;
        setHasMore(false);
      }
      const request = ++historyRequest.current;
      const isCurrent = () => isMounted.current && request === historyRequest.current;
      if (!append) setLoading(true);
      setLoadError(false);

      try {
        /* ── THE `wallet_transactions` HALF OF THIS FETCH IS GONE ───────────────
         It filtered on `category IN (diamond_purchase, diamond_deduction,
         vip_purchase, mint, diamond_reward, diamond_refund)`. Five of those six
         values are REJECTED by `wallet_transactions_category_check`, so no row
         in that table can ever carry them — the query was five-sixths dead by
         construction.

         The sixth, `mint`, is worse than dead. `wallet_transactions` is the
         CHIP ledger; a `mint` row there records chips minted into a treasury.
         Pulling it into the diamond wallet put a chip figure on a diamond
         statement, labelled "Chip Mint", where it read as a diamond balance
         change of that size. Diamonds are counted in ones and chips in tens of
         thousands, so a single mint row could show a player a five-figure
         movement in a wallet that never moved.

         Diamonds live in `diamond_transactions`. One source, one currency. */
        let query = supabase
          .from('diamond_transactions')
          /* `type` is selected as well as `transaction_type`, and that is the
           whole fix for 773 of the ~1,540 rows in this table. `transaction_type`
           is NULL on 774 of them — 557 `reconciliation` rows and 216
           `signup_bonus` rows carry their kind in the older `type` column
           instead — and this component read only `transaction_type`. So a
           player's Welcome Bonus, the first diamond movement on every account
           ever created, rendered in their own wallet as a grey "Adjustment". */
          .select('id, type, transaction_type, amount, player_line, balance_after, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
        // A stable tuple cursor survives newer receipts arriving between pages.
        // The user_id predicate remains outside this OR and scopes every page.
        if (append && cursor) {
          query = query.or(
            `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
          );
        }
        const { data: dtData, error: dtError } = await query.limit(TX_LIMIT);

        /* supabase-js RESOLVES with `{ data: null, error }`; it does not throw.
         Both reads here discarded `error` entirely, so an RLS denial or a
         dropped connection produced an empty array and this modal told the
         player "No Transactions Yet" — a statement about their money that was
         not true, with no error, no retry and nothing in local diagnostics. */
        if (dtError) throw dtError;

        const combined: DiamondTransaction[] = (dtData || []).map((t: any) => ({
          id: t.id,
          type: t.transaction_type || t.type || '',
          transaction_type: t.transaction_type || t.type || '',
          amount: Number(t.amount) || 0,
          line: typeof t.player_line === 'string' ? t.player_line : undefined,
          balance_after: t.balance_after,
          created_at: t.created_at,
        }));

        if (isCurrent()) {
          setTransactions((previous) =>
            append
              ? [
                  ...previous,
                  ...combined.filter((row) => !previous.some((old) => old.id === row.id)),
                ]
              : combined
          );
          const last = combined[combined.length - 1];
          historyCursor.current = last
            ? { owner: user.id, createdAt: last.created_at, id: last.id }
            : null;
          setHasMore(combined.length === TX_LIMIT);
          setHistoryOwnerId(user.id);
        }
      } catch (err) {
        if (isCurrent()) {
          reportError(err, 'DiamondWalletModal.Fetch_error');
          setHistoryOwnerId(user.id);
          if (append) setMoreError(true);
          else setLoadError(true);
        }
      } finally {
        if (isCurrent()) {
          pageInFlight.current = false;
          setLoadingMore(false);
          setLoading(false);
        }
      }
    },
    [user?.id, isOpen, isMounted]
  );

  useEffect(() => {
    const requestRef = historyRequest;
    setTransactions([]);
    setHistoryOwnerId(null);
    historyCursor.current = null;
    pageInFlight.current = false;
    setHasMore(false);
    setLoadingMore(false);
    setMoreError(false);
    setLoadError(false);
    setLoading(true);
    if (isOpen) void fetchTransactions();
    return () => {
      ++requestRef.current;
    };
  }, [isOpen, fetchTransactions]);

  /* The full-screen wallet owns keyboard focus while it is open. Keep focus
     inside its controls, stop the page behind it from scrolling, and return
     the player to the exact control that opened it when the sheet closes. */
  useEffect(() => {
    if (!isOpen) return undefined;

    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /* With the send sheet up, the desk behind it is inert, so Tab cycles the
       sheet alone; otherwise the desk. */
    const scope = () =>
      (sendSheetRef.current ? dialogRef.current?.querySelector<HTMLElement>('.dwc-sheet') : null) ??
      dialogRef.current;
    const focusable = () => Array.from(scope()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const focusFrame = window.requestAnimationFrame(() => {
      (focusable()[0] ?? deskRef.current)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // The transfer sheet closes first, then the wallet; neither while a
        // transfer travels.
        if (sendSheetRef.current) {
          if (!transferBusyRef.current) setSendSheet(false);
          return;
        }
        if (!transferBusyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        deskRef.current?.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      const inside = scope()?.contains(active) ?? false;
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen]);

  /* Opening the send sheet moves focus into it; closing it returns focus to
     the dock word that opened it. */
  const sheetReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isOpen) return undefined;
    if (sendSheet) {
      sheetReturnRef.current = document.activeElement as HTMLElement | null;
      const frame = window.requestAnimationFrame(() => {
        const sheet = dialogRef.current?.querySelector<HTMLElement>('.dwc-sheet');
        const controls = Array.from(sheet?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        (controls.find((el) => !el.classList.contains('sc__close')) ?? controls[0])?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const back = sheetReturnRef.current;
    sheetReturnRef.current = null;
    if (back && document.contains(back)) back.focus();
    return undefined;
  }, [sendSheet, isOpen]);

  // Refresh when diamond balance changes from another component
  useMasterBusSubscription('DIAMOND_BALANCE_CHANGED', () => {
    if (isMounted.current && isOpen) fetchTransactions();
  });

  useMasterBusSubscription('PROFILE_UPDATED', ({ userId }) => {
    if (userId === user?.id && isMounted.current && isOpen) void fetchTransactions();
  });

  // Client-side filter over the fetched page.
  const filteredTx = (historyOwnerId === user?.id ? transactions : []).filter((tx) => {
    const txType = tx.transaction_type || tx.type || '';
    if (filter === 'all') return true;
    if (filter === 'refund') return isRefund(txType);
    if (filter === 'earned') return tx.amount > 0 && !isRefund(txType);
    if (filter === 'spent') return tx.amount < 0;
    return txType === filter;
  });

  if (!isOpen) return null;

  /* ON THE WALLET DESK (Dan 2026-10-16): "When you click the union bank
     wallet, promo wallet or diamond wallet, they should look feel and
     function like this cashier functionality. Remove the bulky generic
     frames." The wallet opens as the Cashier does: the identity row (the
     diamond art, the wallet's name, a white Close), the two custody figures,
     the filter words, the history as hairline rows, and the painted action
     dock with Send Diamonds | Buy Diamonds. A transfer is asked for on the
     flat-crested console (the Marketplace dress, #4805) over the desk, and
     every close path still holds shut while it travels (launch audit D-13). */
  const dockLine = transferBusy
    ? 'Sending'
    : `${FILTER_OPTIONS.find((opt) => opt.value === filter)?.label ?? 'All'} · ${filteredTx.length.toLocaleString()} Entries`;

  /* Portaled to <body> (2026-10-17), as the union desk is, so no host page's
     stacking context can put its nav or header over the desk. */
  return createPortal(
    <div className="diamond-wallet-backdrop" onClick={closeIfIdle} role="presentation">
      <div
        ref={dialogRef}
        className="wdesk__trap"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <WalletDesk
          deskRef={deskRef}
          ariaLabel="Diamond Wallet"
          art={`${import.meta.env.BASE_URL}images/diamond-icon.png`}
          name="Diamond Wallet"
          line="Club Arena Diamonds"
          onClose={closeIfIdle}
          closeDisabled={transferBusy}
          dockLine={dockLine}
          actions={[
            {
              label: 'Send Diamonds',
              lit: true,
              onClick: () => setSendSheet(true),
              disabled: transferBusy || !user?.id,
              'aria-label': 'Send Diamonds',
            },
            {
              label: 'Buy Diamonds',
              onClick: () => {
                if (transferBusyRef.current) return;
                onClose();
                onBuyClick?.();
              },
              disabled: transferBusy,
            },
          ]}
          sheet={
            sendSheet && user?.id ? (
              <div className="dwc-sheet" onClick={closeSendSheet}>
                <div
                  className="dwc"
                  aria-labelledby="dwc-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SpadeConsole
                    /* The X is not rendered while a transfer travels (launch
                       audit D-13), as the cashout sheet and the mint already
                       do. The flat crest stays: it is the deliberate
                       Marketplace dress (#4805), pinned by
                       tests/marketplace-console-visual-contract.test.ts, and
                       the Cashier console law carries the allowance for it. */
                    onClose={transferBusy ? undefined : closeSendSheet}
                    crest="flat"
                    eyebrow="Diamond Wallet"
                    title="Send Diamonds"
                    titleId="dwc-title"
                    pill={transferBusy ? 'Sending' : 'Friends'}
                    pillInk={transferBusy ? 'gold' : 'blue'}
                    plates={{
                      secondary: {
                        label: 'Back',
                        ink: 'silver',
                        onClick: closeSendSheet,
                        disabled: transferBusy,
                        'aria-label': 'Back',
                      },
                      primary: {
                        label: 'Buy Diamonds',
                        ink: 'white',
                        disabled: transferBusy,
                        onClick: () => {
                          if (transferBusyRef.current) return;
                          onClose();
                          onBuyClick?.();
                        },
                      },
                    }}
                    className="dwc__console"
                  >
                    <DiamondWalletTransfer
                      key={user.id}
                      userId={user.id}
                      initiallyOpen
                      onBusyChange={onTransferBusyChange}
                      onComplete={() => {
                        setBalanceRevision((value) => value + 1);
                        void fetchTransactions();
                      }}
                    />
                  </SpadeConsole>
                </div>
              </div>
            ) : null
          }
        >
          {/* Balances: available and in play are two figures, never a total. */}
          <div className="diamond-wallet-modal__custody-balances">
            <DiamondCustodyBalance key={balanceRevision} />
          </div>

          {/* Filters: lit words in a row; the chosen one burns white. */}
          <div className="wdesk__words" role="group" aria-label="Filter Transactions">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="wdesk__word"
                aria-pressed={filter === opt.value}
                onClick={() => setFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <WalletDeskHeading
            title="History"
            meta={`${filteredTx.length.toLocaleString()} Entries`}
          />

          {/* Receipts */}
          <div className="wdesk__list">
            {loading || historyOwnerId !== user?.id ? (
              <p className="wdesk__empty" role="status">
                Loading Transactions
              </p>
            ) : loadError ? (
              /* "No Transactions Yet" is a claim about the player's money. It
                 must never be shown for a read that failed - see the error note
                 in fetchTransactions. */
              <div className="wdesk__empty" role="status">
                <p>Could Not Load Your Diamond History</p>
                <button type="button" className="wdesk__more" onClick={() => fetchTransactions()}>
                  Retry
                </button>
              </div>
            ) : filteredTx.length === 0 ? (
              <p className="wdesk__empty">
                {filter === 'all'
                  ? 'No Transactions Yet'
                  : hasMore
                    ? 'No Matching Transactions Loaded Yet'
                    : 'No Transactions Of This Kind'}
              </p>
            ) : (
              filteredTx.map((tx) => {
                const txType = tx.transaction_type || tx.type || '';
                const label = diamondTxLabel(txType);
                const isPositive = tx.amount >= 0;
                const dt = new Date(tx.created_at);

                return (
                  <WalletDeskRow
                    key={tx.id}
                    name={label}
                    sub={
                      <>
                        {/* Phase 6: the ledger's own player line, never the
                            raw description - an operator's audit note, a
                            challenge id or a test row is not the player's. */}
                        <span>{formatPopupText(tx.line || label)}</span>
                        <br />
                        <span>
                          {dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                          {dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {tx.balance_after != null && (
                          <span className="wdesk__sep">
                            Balance {tx.balance_after.toLocaleString()}
                          </span>
                        )}
                      </>
                    }
                    figure={
                      <span className={isPositive ? 'wdesk__in' : 'wdesk__out'}>
                        {isPositive ? '+' : ''}
                        {tx.amount.toLocaleString()}
                      </span>
                    }
                  />
                );
              })
            )}
          </div>
          {!loading && !loadError && historyOwnerId === user?.id && transactions.length > 0 && (
            <div className="wdesk__list">
              {moreError ? (
                <div className="wdesk__empty wdesk__empty--bad" role="status">
                  <p>Could Not Load Older Diamonds.</p>
                  <button
                    type="button"
                    className="wdesk__more"
                    disabled={loadingMore}
                    onClick={() => void fetchTransactions(true)}
                  >
                    Retry
                  </button>
                </div>
              ) : hasMore ? (
                <button
                  type="button"
                  className="wdesk__more"
                  onClick={() => void fetchTransactions(true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : 'Load Older Diamonds'}
                </button>
              ) : (
                <p className="wdesk__empty">
                  That Is Every Diamond Movement. {transactions.length.toLocaleString()} Entries.
                </p>
              )}
            </div>
          )}
        </WalletDesk>
      </div>
    </div>,
    document.body
  );
}
