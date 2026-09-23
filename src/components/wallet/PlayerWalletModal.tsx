/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLAYER WALLET (Dan 2026-08-24, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE ALL TRANSACTIONS
 *  AND OTHER AVAILABLE DATA WHEN CLICKED."
 *
 * The wallet panel's Player Wallet row opens THIS: the viewer's own club
 * statement. Every chip movement they were a party to, newest first, with
 * received / sent / net totals and every balance they hold in the club.
 *
 * It reads through fn_my_wallet_ledger, which is auth.uid() scoped on the
 * server — it can only ever return the CALLER's own rows, so any active
 * member may open it and nobody can open anyone else's. This is a statement,
 * not a cashier: nothing here moves money.
 *
 * Styling rides on the cashier's cbc- classes so the two read as one family.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { reportError } from '../../utils/errorReporter';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { roleLabel } from '../../types/clubRoles';
import { canHoldAgentWallet } from './walletRows';
import { titleCase, enumToTitleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
import './WalletCashierModal.css';

const PAGE = 40;

/**
 * Module-scope so the array identity is stable: useMasterBusSubscriptions keys
 * its effect on `eventTypes.join(',')`, so a literal would be harmless here,
 * but a stable constant is what the rest of the wallet surfaces use and it
 * keeps the list in one readable place.
 */
const BUS_EVENTS = [
  'BALANCE_UPDATED',
  'WALLET_REFRESHED',
  'CHIPS_ADDED',
  'CHIPS_DISTRIBUTED',
] as const;

interface MyLedgerRow {
  id: string;
  created_at: string;
  amount: number;
  transaction_type: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  is_reversed: boolean;
  direction: 'in' | 'out';
  from_name: string | null;
  to_name: string | null;
}

interface MyBalances {
  player_wallet: number;
  agent_wallet: number;
  promo_wallet: number;
}

interface MyTotals {
  received: number;
  sent: number;
  net: number;
}

interface PlayerWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Club code or UUID. Resolved internally, same as the cashier. */
  clubId: string;
}

/**
 * A chip figure on the statement. Dan: "NEVER USE DECIMAL POINTS ON ANY
 * FORWARD FACING PAGE", so a whole balance prints 12,500 and not 12,500.00;
 * a ledger never misstates a figure, so one that really carries cents keeps
 * them. Nothing pins two-decimal DISPLAY here: the two-decimal law
 * (tests/a-chip-is-two-decimals-on-every-money-path.test.ts) is about what
 * is stored and sent, and this only prints.
 *
 * A figure that is not a number is UNAVAILABLE. This used to print a
 * confident 0.00 for anything non-finite, which is an invented balance.
 */
const fmt = (n: number | string | null | undefined): string => {
  if (n === null || n === undefined || n === '') return 'Unavailable';
  const v = Number(n);
  return Number.isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : 'Unavailable';
};

/**
 * Names for the `chip_transactions.transaction_type` values that actually occur
 * in production, checked against the live table on 2026-08-25.
 *
 * `titleCase` alone gets most of them right - "club_bank_send" really is "Club
 * Bank Send" - but it lower-cases the tail of every word, so the ones carrying
 * an acronym came out mangled: "Bbj Promo Sweep", "Union Pnl Payout". This map
 * covers those and the cash-out lifecycle, where the bare enum is ambiguous on
 * a statement ("cashout" is a TABLE cash-out; "cashout_request" is a player
 * asking their agent for chips, which is a different event with a different
 * outcome). Anything absent still falls through to titleCase, so a type added
 * server-side tomorrow reads as English rather than as an enum or a blank.
 */
const TX_TYPE_LABELS: Record<string, string> = {
  // Table money
  buy_in: 'Buy In',
  buyin: 'Buy In',
  cashout: 'Table Cash Out',
  cash_out: 'Table Cash Out',
  topup: 'Top Up',
  addon_refund: 'Add-On Refund',
  tournament_buyin: 'Tournament Buy In',
  tournament_refund: 'Tournament Refund',
  prize: 'Prize',
  prize_reversal: 'Prize Reversal',
  // Cash-out lifecycle (escrow -> agent float, or back to the player)
  cashout_request: 'Cash Out Requested',
  cashout_approved: 'Cash Out Approved',
  cashout_denied: 'Cash Out Denied',
  cashout_rejected: 'Cash Out Denied',
  cashout_cancelled: 'Cash Out Cancelled',
  cashout_canceled: 'Cash Out Cancelled',
  cashout_expired: 'Cash Out Expired',
  cashout_refund: 'Cash Out Returned',
  cashout_escrow: 'Held In Escrow',
  // Agent / club movements
  agent_funding: 'Agent Funding',
  club_bank_send: 'Club Bank Send',
  club_bank_reversal: 'Club Bank Reversal',
  admin_removal: 'Claimed Back',
  admin_adjustment: 'Admin Adjustment',
  peer_transfer: 'Player Transfer',
  user_transfer: 'Player Transfer',
  transfer_in: 'Transfer In',
  transfer_out: 'Transfer Out',
  // Treasury / minting
  mint: 'Chip Mint',
  treasury_mint: 'Treasury Mint',
  treasury_credit: 'Treasury Credit',
  treasury_debit: 'Treasury Debit',
  chip_credit: 'Chip Credit',
  chip_debit: 'Chip Debit',
  chip_purchase: 'Chip Purchase',
  // Rake and promotions
  rakeback: 'Rakeback',
  bbj_promo_sweep: 'BBJ Promo Sweep',
  promo_closed_on_union_join: 'Promo Wallet Closed On Union Join',
  /* Never 'Horse ...': a statement line may not say which member is a horse
     (Dan 2026-09-14, tests/a-horse-is-never-named.law.test.ts). */
  horse_treasury_funding: 'Treasury Funding',
  union_hold: 'Union Hold',
  union_pnl_collect: 'Union PnL Collected',
  union_pnl_payout: 'Union PnL Payout',
};

/**
 * A row with no type at all must not render an empty cell on a statement - the
 * amount would sit beside nothing and read as an unexplained movement.
 */
export function labelForTransactionType(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return 'Chip Movement';
  /* The house transform (src/utils/titleCase.ts), which keeps the product's
     initialisms: a local copy lower-cased the tail of every word. */
  return TX_TYPE_LABELS[raw] ?? enumToTitleCase(raw.replace(/-+/g, '_'));
}

export default function PlayerWalletModal({ isOpen, onClose, clubId }: PlayerWalletModalProps) {
  const { user } = useAuthUser();
  const isMounted = useIsMounted();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string>('player');
  const [balances, setBalances] = useState<MyBalances | null>(null);
  const [totals, setTotals] = useState<MyTotals | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<MyLedgerRow[]>([]);

  const load = useCallback(
    async (offset: number) => {
      if (!clubId) {
        /* `loading` is initialised true, and this returned before the
           try/finally that clears it - so an unresolvable club left the panel
           on "Loading Your Wallet..." forever, with no error and no way out. */
        setError('That Club Could Not Be Resolved');
        setLoading(false);
        return;
      }
      setLoading(true);
      if (offset === 0) setError(null);
      try {
        const uuid = await resolveClubUUID(clubId);
        if (!isMounted.current) return;
        if (!isUUID(uuid)) {
          setError('That Club Could Not Be Resolved');
          return;
        }
        const { data, error: rpcError } = await supabase.rpc('fn_my_wallet_ledger', {
          p_club_id: uuid,
          p_limit: PAGE,
          p_offset: offset,
        });
        if (rpcError) throw rpcError;
        const res = (Array.isArray(data) ? data[0] : data) as {
          authorized?: boolean;
          error?: string;
          role?: string;
          total?: number;
          balances?: MyBalances;
          totals?: MyTotals;
          rows?: MyLedgerRow[];
        } | null;
        if (!isMounted.current) return;
        if (!res?.authorized) {
          setError(res?.error || 'Your Wallet Could Not Be Read');
          return;
        }
        setRole(res.role || 'player');
        setBalances(res.balances ?? null);
        setTotals(res.totals ?? null);
        setTotal(Number(res.total) || 0);
        /* Offset paging over a table that is still being written to: a chip
           movement landing between page 1 and page 2 shifts the whole window
           down by one, so the last row of page 1 arrives again as the first row
           of page 2. React then renders two children with the same `key`, which
           is a duplicated line on a financial statement, not just a console
           warning. De-duplicated by id on append. */
        setRows((prev) => {
          const next = res.rows || [];
          if (offset === 0) return next;
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...next.filter((r) => !seen.has(r.id))];
        });
      } catch (e) {
        reportError(e, 'PlayerWalletModal.load');
        if (isMounted.current) setError('Could Not Load Your Wallet');
      } finally {
        if (isMounted.current) setLoading(false);
      }
    },
    [clubId, isMounted]
  );

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    setRows([]);
    setTotal(0);
    setBalances(null);
    setTotals(null);
    load(0);
  }, [isOpen, user?.id, load]);

  /**
   * REFRESH ON THE EVENTS THE REST OF THE APP ALREADY EMITS.
   *
   * This panel is opened FROM the Player Wallet row of DynamicWallet, which
   * refetches on all nine WALLET_BUS_EVENTS. The statement it opens did not
   * listen to any of them: it fetched once and then sat there. A player who
   * opened their wallet, was sent chips by their agent, and watched the row
   * behind the modal tick up, still saw the old balance and no new line here.
   *
   * Page 0 only, and only while the user is still ON page 0 - reloading from
   * the top would otherwise throw away every "Load More" they had pressed,
   * mid-read, because a movement happened somewhere in the club.
   */
  /* The hook keeps the handler in a ref it refreshes every render, so this
     closure always sees the current `isOpen` and `rows` without either being a
     dependency - and without writing a ref during the render body, which React
     19 is entitled to throw away. */
  useMasterBusSubscriptions(
    [...BUS_EVENTS],
    () => {
      if (!isOpen) return;
      if (rows.length > PAGE) return;
      load(0);
    },
    { debounce: 500 }
  );

  // Escape closes, and the page behind stops scrolling — same manners as the
  // cashier, for the same reasons.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isAgentShaped = canHoldAgentWallet(role);

  /* A BALANCE THAT COULD NOT BE READ IS NOT A BALANCE OF ZERO. While the
     statement loads the figure is "..."; once a read has failed it says so,
     rather than sitting on "..." forever or printing an invented figure. */
  const balanceText = error
    ? 'Unavailable'
    : balances === null
      ? '...'
      : fmt(balances.player_wallet);

  return (
    <div
      className="cbc-overlay wcm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Player Wallet"
      onClick={onClose}
    >
      <div className="cbc-panel wcm ac-popup" onClick={(e) => e.stopPropagation()}>
        {/* ON THE SPADE CONSOLE (#ClubArenaConsole), paired with the Club Bank
            cashier's own sheet: the same glass, the same rows, the same inks.
            One action (Close), so the foot is the flat cap and Close is a lit
            word at the bottom of the glass. The spade is the default crest. */}
        <SpadeConsole
          as="div"
          eyebrow="Player Cashier"
          title="Player Wallet"
          titleId="player-wallet-title"
          subtitle="Personal Club Statement"
          pill={loading ? 'Syncing' : error ? 'Attention' : 'Recorded'}
          pillInk={loading ? 'gold' : error ? 'red' : 'green'}
          foot="foot"
        >
          <div className="cbc-bank">
            <span>Player Wallet Balance</span>
            <strong aria-live="polite">{balanceText}</strong>
          </div>

          <div className="cbc-body">
            {error && <div className="cbc-empty cbc-empty--bad">{error}</div>}

            {/* Every balance the member holds in this club, one per line. The
                agent rows only exist for agent-shaped roles: a plain player has
                one wallet and is shown one wallet. */}
            {!error && balances && (
              <>
                <div className="cbc-row">
                  <span className="sc-label sc-ink--blue">Role</span>
                  <strong className="sc-ink--silver">{roleLabel(role)}</strong>
                </div>
                {isAgentShaped && (
                  <div className="cbc-row">
                    <span className="sc-label sc-ink--blue">Agent Wallet</span>
                    <strong className="sc-ink--silver">{fmt(balances.agent_wallet)}</strong>
                  </div>
                )}
                {isAgentShaped && (
                  <div className="cbc-row">
                    <span className="sc-label sc-ink--blue">Promo Wallet</span>
                    <strong className="sc-ink--silver">{fmt(balances.promo_wallet)}</strong>
                  </div>
                )}
              </>
            )}

            {!error && totals && (
              <div className="cbc-totals">
                <div>
                  <span>Received</span>
                  <strong className="cbc-in">{fmt(totals.received)}</strong>
                </div>
                <div>
                  <span>Sent</span>
                  <strong className="cbc-out">{fmt(totals.sent)}</strong>
                </div>
                <div>
                  <span>Net</span>
                  <strong>{fmt(totals.net)}</strong>
                </div>
              </div>
            )}

            {!error && (
              <div className="cbc-ledger-head">
                <span>{total.toLocaleString('en-US')} Transactions</span>
              </div>
            )}

            {!error &&
              rows.map((row) => (
                <div
                  key={row.id}
                  className={row.is_reversed ? 'cbc-tx cbc-tx--reversed' : 'cbc-tx'}
                >
                  <div className="cbc-tx-top">
                    <span className="cbc-tx-type">
                      {labelForTransactionType(row.transaction_type)}
                    </span>
                    <span className="cbc-tx-amount">
                      {row.direction === 'in' ? '+' : '-'}
                      {fmt(row.amount)}
                    </span>
                  </div>
                  <div className="cbc-tx-mid">
                    <span>
                      {titleCase(row.from_name) || 'Club Bank'}
                      {' → '}
                      {titleCase(row.to_name) || 'Club Bank'}
                    </span>
                    <span className="cbc-tx-when">
                      {new Date(row.created_at).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="cbc-tx-foot">
                    {row.notes && <span>{titleCase(row.notes)}</span>}
                    {row.is_reversed && <span className="cbc-tx-rev">Reversed</span>}
                  </div>
                </div>
              ))}

            {!error && !loading && rows.length === 0 && (
              <div className="cbc-empty">No Transactions Yet. Your Chip Movements Land Here.</div>
            )}
            {loading && <div className="cbc-empty">Loading Your Wallet...</div>}
            {!error && !loading && rows.length < total && (
              <button className="cbc-more" onClick={() => load(rows.length)}>
                Load More
              </button>
            )}

            {/* Close, the one action, as a lit word (never a glyph). Escape and
                the backdrop still close too. */}
            <div className="cbc-actions">
              <button className="cbc-x" onClick={onClose} aria-label="Close">
                Close
              </button>
            </div>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}
