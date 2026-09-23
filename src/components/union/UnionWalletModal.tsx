/**
 *  UNION WALLET MODAL — open a union wallet, send funds to any union member or club
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-22: "WHEN OWNER, CO OWNER OR ADMIN CLICKS ON ANY OF THE WALLETS
 * IT SHOULD OPEN UP, AND THEY BE ABLE TO SEND CHIPS, DIAMONDS OR PROMO FUNDS
 * TO ANY MEMBER OF THE UNION."
 *
 * Dan 2026-08-27: "pull and send chips to any club, club wallet, player wallet
 * or agent wallet from the union bank wallet, or promo wallet"
 *
 * Dan 2026-09-05: "MAKE SURE YOU ADD AND HAVE A TRANSACTION LEDGER ATTACHED TO
 * EVERY PROMO WALLET." Every wallet this modal opens now carries a Ledger tab
 * read from fn_promo_wallet_ledger (scope 'union', any wallet column).
 *
 * The member list is the union-wide roster (fn_union_player_directory): every
 * player of every member club, with their role. We also fetch union_clubs to
 * support sending to and clawing back from clubs.
 *
 * The BBJ wallet is a jackpot reserve — fn_union_chip_integrity_check audits
 * it — so it is not offered as a chip SOURCE. Opening it still gives the full
 * send flow, drawing on the main bank instead.
 *
 * ── A CLUB SEND GOES WHERE THE OPEN WALLET SAYS IT GOES (2026-09-05, binding) ──
 *
 * On 2026-09-05 02:51 UTC Dan opened THIS modal on the Promo Wallet, picked
 * Club JAQK and then SHARK CLUB, and sent 5,000 to each. Both went through
 * `unionApi.sendToClub` (fn_union_send_to_club_atomic), which only knows one
 * route: union BANK -> club BANK. The chips left the wrong union wallet and
 * landed in the wrong club wallet, stamped "Promo Wallet to club". Nothing
 * reached a promo account and Dan reported the chips as missing.
 *
 * So a club target is routed by `clubSendRoute` below, which a law test pins:
 *   promo wallet, or Promo kind  -> unionApi.promoSend(..., 'club', clubId)
 *                                   union promo wallet -> club Promo Wallet
 *   union bank / BBJ, Chips kind -> unionApi.sendToClub
 *                                   union bank -> Club Bank
 *   rake wallet                  -> refused here (no rake -> club route exists;
 *                                   the old code silently drew on the bank)
 *   diamonds                     -> refused here (a club has no diamond wallet)
 * A refused route is a sentence on screen, never a silent substitution.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { reportError } from '../../utils/errorReporter';
import { fmt } from '../../utils/format';
import { unionApi } from '../../services/UnionApiService';
import {
  clearUnionWalletOperation,
  reserveUnionWalletOperation,
  unionWalletIntentSignature,
  type UnionWalletIntentScope,
} from '../../services/UnionWalletRecovery';
import {
  clubSendRoute,
  clubPullRoute,
  UNION_WALLET_COLUMN,
  type UnionSendKind,
} from './unionWalletRoutes';
import '../wallet/WalletCashierModal.css';
import './UnionWalletModal.css';
import CashierConsoleSurface from '../cashier/CashierConsoleSurface';

// Keep this union explicit at the UI boundary. Static release certification
// verifies that the reserve wallet remains a first-class, read-only modal key.
export type UnionWalletKey = 'chips' | 'rake' | 'bbj' | 'promo' | 'spin_reserve';

export interface UnionWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  unionId: string;
  walletKey: UnionWalletKey;
  walletLabel: string;
  balance: number;
  /** Called after a successful send so the dashboard can refresh balances. */
  onSent?: () => void;
}

interface RosterRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  club_id: string;
  club_name: string | null;
  member_role: string | null;
  member_status: string | null;
}

type SendKind = UnionSendKind;
type Mode = 'send' | 'pull' | 'ledger';

const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  co_owner: 1,
  admin: 2,
  super_agent: 3,
  agent: 4,
  member: 5,
};

const LEDGER_PAGE = 40;

interface LedgerRow {
  id: string;
  created_at: string;
  amount: number;
  direction: 'in' | 'out';
  category: string;
  notes: string | null;
  balance_after: number | null;
  counterparty_type: string | null;
  counterparty_name: string | null;
  actor_name: string | null;
}

interface LedgerTotals {
  in: number;
  out: number;
  net: number;
}

/** "Promo To Club" from "promo_to_club". Popup and label casing law. */
function titleCase(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The union-wallet API refuses a note carrying ; ' " or a backslash
 * (SafeNotes in the World Hub contract). A club called "Dan's Room" would
 * otherwise turn a valid send into a 400 with nothing on screen to say why.
 */
const apiNote = (s: string) => s.replace(/[;'"\\]/g, '').slice(0, 500);

const definitiveRefusal = (message: string): Error & { definitive: true } =>
  Object.assign(new Error(message), { definitive: true as const });

/** Ledger money, always to the hundredth: 5,000.00, never 5,000 beside 32,482.58. */
const money = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function UnionWalletModal({
  isOpen,
  onClose,
  unionId,
  walletKey,
  walletLabel,
  balance,
  onSent,
}: UnionWalletModalProps) {
  const { user } = useAuthUser();
  const [mode, setMode] = useState<Mode>('send');
  const [clubs, setClubs] = useState<Array<{ id: string; name: string }>>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryReload, setDirectoryReload] = useState(0);
  const directoryLoadVersion = useRef(0);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<
    | { type: 'member'; data: RosterRow }
    | { type: 'club'; data: { id: string; name: string } }
    | null
  >(null);
  const [kind, setKind] = useState<SendKind>(walletKey === 'promo' ? 'promo' : 'chips');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  /** Synchronous guard for two taps that arrive before React paints `busy`. */
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [liveBalance, setLiveBalance] = useState(balance);
  const [reserveLedger, setReserveLedger] = useState<
    Array<{
      id: string;
      amount: number;
      direction: string;
      tx_type: string;
      notes: string | null;
      balance_after: number | null;
      created_at: string;
    }>
  >([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerTotals, setLedgerTotals] = useState<LedgerTotals | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const chipSource = walletKey === 'rake' ? 'rake' : walletKey === 'promo' ? 'promo' : 'chips';

  const requestClose = useCallback(() => {
    if (busyRef.current) {
      setNotice({ ok: false, text: 'Wait For The Current Money Move To Finish.' });
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, requestClose]);

  const readOnly = walletKey === 'spin_reserve';

  useEffect(() => {
    if (!isOpen) return;
    const loadVersion = ++directoryLoadVersion.current;
    const isCurrent = () => directoryLoadVersion.current === loadVersion;
    setNotice(null);
    setDirectoryError(null);
    setTarget(null);
    setAmount('');
    setMode('send');
    setLiveBalance(balance);
    setKind(walletKey === 'promo' ? 'promo' : 'chips');
    setLedger([]);
    setLedgerTotals(null);
    setLedgerError(null);

    if (readOnly) {
      void supabase
        .from('union_wallet_transactions')
        .select('id, amount, direction, tx_type, notes, balance_after, created_at')
        .eq('union_id', unionId)
        .eq('wallet', 'spin_reserve_wallet')
        .order('created_at', { ascending: false })
        .limit(25)
        .then(({ data, error }) => {
          if (!isCurrent()) return;
          if (error) {
            reportError(error, 'UnionWalletModal.reserve_ledger_load_failed');
            setNotice({ ok: false, text: 'Could Not Load The Spin Reserve Ledger.' });
          }
          setReserveLedger((data as typeof reserveLedger) || []);
        });
      setRoster([]);
      setClubs([]);
      setLoading(false);
      return () => {
        if (isCurrent()) ++directoryLoadVersion.current;
      };
    }
    setReserveLedger([]);

    setLoading(true);
    void Promise.all([
      supabase.rpc('fn_union_player_directory', { p_union_id: unionId }),
      supabase.from('union_clubs').select('*, clubs:club_id(*)').eq('union_id', unionId),
    ])
      .then(([rosterRes, clubsRes]) => {
        if (!isCurrent()) return;
        const failures: string[] = [];
        if (rosterRes.error) {
          reportError(rosterRes.error, 'UnionWalletModal.roster_load_failed');
          failures.push('Union Roster');
          setRoster([]);
        } else {
          setRoster((rosterRes.data as RosterRow[]) || []);
        }

        if (clubsRes.error) {
          reportError(clubsRes.error, 'UnionWalletModal.clubs_load_failed');
          failures.push('Club Wallets');
          setClubs([]);
        } else {
          const enriched = (clubsRes.data || []).map((uc: any) => ({
            id: uc.club_id,
            name: uc.clubs?.name || 'Unknown Club',
          }));
          setClubs(enriched);
        }
        setDirectoryError(failures.length > 0 ? `Could Not Load ${failures.join(' And ')}.` : null);
      })
      .catch((error) => {
        if (!isCurrent()) return;
        reportError(error, 'UnionWalletModal.directory_load_failed');
        setRoster([]);
        setClubs([]);
        setDirectoryError('Could Not Load The Union Wallet Directory.');
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    /* `balance` is deliberately NOT a dependency: onSent makes the dashboard
       reload and pass a fresh balance, and re-running this reset on that would
       wipe the success notice and the picked target the moment a send lands.
       The live figure comes from the send's own response instead. */

    return () => {
      if (isCurrent()) ++directoryLoadVersion.current;
    };
  }, [isOpen, unionId, walletKey, user?.id, directoryReload]);

  /**
   * THE LEDGER TAB. fn_promo_wallet_ledger scope 'union' reads
   * union_wallet_transactions for the open wallet's column, newest first, with
   * the club and the person on each row named. Same RPC the club promo wallet
   * uses, so a chip that leaves here can be found there under the same words.
   */
  const loadLedger = useCallback(
    async (offset: number) => {
      setLedgerLoading(true);
      setLedgerError(null);
      try {
        const { data, error } = await supabase.rpc('fn_promo_wallet_ledger', {
          p_scope: 'union',
          p_scope_id: unionId,
          p_limit: LEDGER_PAGE,
          p_offset: offset,
          p_wallet: UNION_WALLET_COLUMN[walletKey],
        });
        if (error) throw error;
        const res = (Array.isArray(data) ? data[0] : data) as {
          authorized?: boolean;
          error?: string;
          total?: number;
          totals?: LedgerTotals;
          rows?: LedgerRow[];
        } | null;
        if (!res?.authorized) {
          setLedgerError(res?.error || 'The Ledger Is Not Available To You.');
          setLedger([]);
          return;
        }
        /* Totals and the count are computed for the FIRST page only (a
           million-row rake wallet does not re-sum on every Load More); a later
           page answers null for both and the figures already on screen stand. */
        if (offset === 0 || res.total != null) setLedgerTotal(Number(res.total) || 0);
        if (offset === 0 || res.totals) setLedgerTotals(res.totals ?? null);
        setLedger((prev) => (offset === 0 ? res.rows || [] : [...prev, ...(res.rows || [])]));
      } catch (e) {
        reportError(e, 'UnionWalletModal.ledger_load_failed');
        setLedgerError('Could Not Load The Ledger.');
      } finally {
        setLedgerLoading(false);
      }
    },
    [unionId, walletKey]
  );

  useEffect(() => {
    if (!isOpen || readOnly || mode !== 'ledger') return;
    void loadLedger(0);
  }, [isOpen, readOnly, mode, loadLedger]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    const matchedClubs = q ? clubs.filter((c) => c.name.toLowerCase().includes(q)) : clubs;

    const matchedRoster = q
      ? roster.filter(
          (r) =>
            (r.display_name || '').toLowerCase().includes(q) ||
            (r.username || '').toLowerCase().includes(q) ||
            (r.club_name || '').toLowerCase().includes(q)
        )
      : roster;

    const sortedRoster = [...matchedRoster].sort(
      (a, b) =>
        (ROLE_ORDER[a.member_role || 'member'] ?? 9) - (ROLE_ORDER[b.member_role || 'member'] ?? 9)
    );

    return { clubs: matchedClubs, roster: sortedRoster };
  }, [clubs, roster, search]);

  const route = clubSendRoute(walletKey, kind);
  const pullRoute = clubPullRoute(walletKey);
  const clubRefusal =
    mode === 'send' && route.kind === 'refused'
      ? route.reason
      : mode === 'pull' && pullRoute.kind === 'refused'
        ? pullRoute.reason
        : null;

  const send = useCallback(async () => {
    const amt = Number(amount);
    if (
      !target ||
      mode === 'ledger' ||
      !Number.isFinite(amt) ||
      amt <= 0 ||
      busy ||
      busyRef.current
    )
      return;
    if (kind === 'diamonds' && amt !== Math.floor(amt)) {
      setNotice({ ok: false, text: 'Diamonds Must Be A Whole Number.' });
      return;
    }
    /* The union-wallet API contract (PositiveChipAmount) FLOORS a club
       amount. 250.5 would leave as 250 while this screen subtracted 250.5,
       so a club send is whole chips here, before anything is sent. A member
       send goes straight to the RPC, which accepts hundredths. */
    if (target.type === 'club' && !Number.isInteger(amt)) {
      setNotice({ ok: false, text: 'Club Sends Move In Whole Chips.' });
      return;
    }
    if (mode === 'pull' && target.type === 'member') {
      setNotice({ ok: false, text: 'Member Clawbacks Must Be Performed By The Club Owner.' });
      return;
    }
    const selectedRoute =
      mode === 'send' ? clubSendRoute(walletKey, kind) : clubPullRoute(walletKey);
    if (target.type === 'club' && selectedRoute.kind === 'refused') {
      setNotice({ ok: false, text: selectedRoute.reason });
      return;
    }
    if (!user?.id) {
      setNotice({ ok: false, text: 'Your Session Must Finish Loading Before Moving Funds.' });
      return;
    }

    const intentScope: UnionWalletIntentScope = {
      userId: user.id,
      unionId,
      walletKey,
      signature: unionWalletIntentSignature({
        mode,
        targetType: target.type,
        targetId: target.type === 'member' ? target.data.user_id : target.data.id,
        kind,
        amount: amt,
        sourceWallet: mode === 'pull' ? selectedRoute.kind : kind === 'chips' ? chipSource : kind,
      }),
    };
    /* Reserve BEFORE the RPC/fetch. A browser that cannot durably remember
       the operation id cannot safely recover a committed-but-lost response,
       so the money door stays closed. */
    const opId = reserveUnionWalletOperation(intentScope);
    if (!opId) {
      const storageError = new Error('Union Wallet operation id could not be stored');
      reportError(storageError, 'UnionWalletModal.operation_recovery_write_failed');
      setNotice({
        ok: false,
        text: 'Union Wallet Safety Storage Is Unavailable. Free Browser Storage And Try Again.',
      });
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setNotice(null);

    try {
      if (mode === 'send') {
        if (target.type === 'member') {
          const { data, error } = await supabase.rpc('fn_union_send_to_member', {
            p_union_id: unionId,
            p_target_user_id: target.data.user_id,
            p_kind: kind,
            p_amount: amt,
            p_source_wallet: kind === 'chips' ? chipSource : null,
            p_note: `${walletLabel} To ${target.data.display_name || target.data.username || 'Member'}`,
            p_op_id: opId,
          });
          const res = (data ?? {}) as {
            success?: boolean;
            error?: string;
            wallet_after?: number;
            destination?: string;
          };
          if (error) throw definitiveRefusal(error.message || 'union send failed');
          if (!res.success) throw definitiveRefusal(res.error || 'union send failed');
          const who = target.data.display_name || target.data.username;
          const landed =
            res.destination === 'promo_float'
              ? ' Into Their Promo Float'
              : res.destination === 'agent_wallet'
                ? ' Into Their Agent Wallet'
                : res.destination === 'player_wallet'
                  ? ' Into Their Player Wallet'
                  : '';
          setNotice({
            ok: true,
            text: `Sent ${fmt(amt)} ${kind === 'chips' ? 'Chips' : kind === 'diamonds' ? 'Diamonds' : 'Promo Chips'} To ${who}.${landed ? landed + '.' : ''}`,
          });
          if (res.wallet_after != null) setLiveBalance(res.wallet_after);
        } else {
          const r = clubSendRoute(walletKey, kind);
          if (r.kind === 'refused') throw new Error(r.reason);
          if (r.kind === 'promo') {
            /* THE PROMO ROUTE. Union promo wallet -> the club's PROMO WALLET
               (clubs.promo_balance), through fn_union_promo_send. Never the
               chip bank, never the club treasury: that is the 2026-09-05 bug. */
            const sent = (await unionApi.promoSend(
              unionId,
              amt,
              'club',
              target.data.id,
              apiNote(`${walletLabel} To ${target.data.name} Promo Wallet`),
              opId
            )) as { promoAfter?: number | null };
            setNotice({
              ok: true,
              text: `Sent ${fmt(amt)} Promo Chips Into The ${target.data.name} Promo Wallet.`,
            });
            // The wallet's figure after the send, from the row that moved it,
            // rather than a subtraction on this screen.
            if (typeof sent?.promoAfter === 'number') setLiveBalance(sent.promoAfter);
            else setLiveBalance((prev) => prev - amt);
          } else {
            const sent = (await unionApi.sendToClub(
              unionId,
              target.data.id,
              amt,
              apiNote(`${walletLabel} To ${target.data.name} Club Bank`),
              opId
            )) as { unionBalanceAfter?: number | null };
            setNotice({
              ok: true,
              text: `Sent ${fmt(amt)} Chips Into The ${target.data.name} Club Bank.`,
            });
            if (typeof sent?.unionBalanceAfter === 'number') setLiveBalance(sent.unionBalanceAfter);
            else setLiveBalance((prev) => prev - amt);
          }
        }
      } else {
        if (target.type === 'club') {
          /* A PULL COMES BACK TO THE WALLET THAT IS OPEN. The promo wallet
             pulls from the club's Promo Wallet through
             fn_union_clawback_promo_from_club; the union bank pulls from the
             Club Bank through fn_union_clawback_from_club. Any other wallet is
             refused above rather than quietly pulling into the bank. Both
             calls carry an op id so a retried tap cannot pull twice. */
          const pr = clubPullRoute(walletKey);
          if (pr.kind === 'refused') throw new Error(pr.reason);
          const isPromoPull = pr.kind === 'promo';
          const { data: cbRes, error: cbErr } = await supabase.rpc(
            isPromoPull ? 'fn_union_clawback_promo_from_club' : 'fn_union_clawback_from_club',
            {
              p_union_id: unionId,
              p_club_id: target.data.id,
              p_amount: amt,
              p_notes: isPromoPull
                ? apiNote(`${walletLabel} Pulled Back From ${target.data.name} Promo Wallet`)
                : apiNote(`${walletLabel} Pulled Back From ${target.data.name} Club Bank`),
              p_op_id: opId,
            }
          );
          if (cbErr) throw definitiveRefusal(cbErr.message || 'Clawback failed');
          const cb = (cbRes ?? {}) as {
            success?: boolean;
            error?: string;
            duplicate?: boolean;
            promo_after?: number;
            union_balance?: number;
          };
          if (cb.success === false) {
            if (cb.duplicate) {
              clearUnionWalletOperation(intentScope, opId);
              setAmount('');
              setNotice({
                ok: true,
                text: 'This Money Move Was Already Processed. The Wallet Is Refreshing.',
              });
              try {
                onSent?.();
              } catch (callbackError) {
                reportError(callbackError, 'UnionWalletModal.on_sent_failed');
              }
              return;
            }
            const msg = cb.error || 'Clawback failed';
            throw definitiveRefusal(
              msg.includes('insufficient club promo')
                ? 'The Club Promo Wallet Does Not Hold That Much.'
                : msg.includes('insufficient')
                  ? 'Club Has Insufficient Treasury Balance'
                  : msg
            );
          }
          setNotice({
            ok: true,
            text: isPromoPull
              ? `Pulled ${fmt(amt)} Promo Chips Back From The ${target.data.name} Promo Wallet.`
              : `Pulled ${fmt(amt)} Chips Back From The ${target.data.name} Club Bank.`,
          });
          const after = isPromoPull ? cb.promo_after : cb.union_balance;
          if (typeof after === 'number') setLiveBalance(after);
          else setLiveBalance((prev) => prev + amt);
        }
      }
      clearUnionWalletOperation(intentScope, opId);
      setAmount('');
      try {
        onSent?.();
      } catch (callbackError) {
        // Refresh failures do not turn a confirmed money movement into a
        // failure banner or invite the operator to submit it again.
        reportError(callbackError, 'UnionWalletModal.on_sent_failed');
      }
    } catch (err: any) {
      if (err?.definitive === true) clearUnionWalletOperation(intentScope, opId);
      reportError(err, 'UnionWalletModal.action_failed');
      setNotice({ ok: false, text: err.message || 'The Action Was Refused.' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    amount,
    target,
    busy,
    kind,
    mode,
    unionId,
    chipSource,
    walletLabel,
    walletKey,
    onSent,
    user?.id,
  ]);

  if (!isOpen) return null;

  const isPromo = walletKey === 'promo';
  const sendDisabled =
    !target ||
    !(Number(amount) > 0) ||
    !user?.id ||
    loading ||
    Boolean(directoryError) ||
    busy ||
    (mode === 'send' && target.type === 'club' && route.kind === 'refused') ||
    (mode === 'pull' && target.type === 'club' && pullRoute.kind === 'refused');

  return (
    <div
      className="cbc-overlay uwm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${walletLabel} Cashier`}
      onClick={requestClose}
    >
      <div className="cbc-panel uwm-panel" onClick={(e) => e.stopPropagation()}>
        <CashierConsoleSurface
          eyebrow="Union Cashier"
          title={walletLabel}
          subtitle={readOnly ? 'Reserve Ledger' : 'Union Wallet'}
          pill={busy ? 'Processing' : readOnly ? 'Read Only' : 'Live'}
          pillInk={busy ? 'gold' : readOnly ? 'muted' : 'green'}
          crest="vip"
          className="cbc-console uwm-console"
          actions={
            !readOnly && mode !== 'ledger'
              ? {
                  secondary: {
                    label: 'Close',
                    disabled: busy,
                    onClick: requestClose,
                  },
                  primary: {
                    label: busy
                      ? mode === 'send'
                        ? 'Sending'
                        : 'Pulling'
                      : !target
                        ? 'Pick A ' + 'Member Or Club'
                        : mode === 'send'
                          ? `Send To ${target.type === 'club' ? target.data.name : target.data.display_name || target.data.username}`
                          : `Pull From ${target.type === 'club' ? target.data.name : 'Target'}`,
                    ink: mode === 'pull' ? 'gold' : 'blue',
                    disabled: sendDisabled,
                    onClick: () => void send(),
                  },
                }
              : undefined
          }
        >
          {/* ── Header ─────────────────────────────────────────────────────── */}
          <div className="cbc-head">
            <div>
              <div className="cbc-title">{walletLabel}</div>
              <p className="uwm-sub">
                {readOnly ? (
                  <>
                    The Capital Every Spin Bonus Pool Is Seeded From, And Every Spin Prize Is Paid
                    Out Of. It Is Not A Send Source: Add Funds With Fund Spin Reserve On The Wallet
                    Tab.
                  </>
                ) : isPromo ? (
                  <>
                    Promo Chips For The Union. To A Club They Land In The Club Promo Wallet. To A
                    Player They Are As Good As Cash. To An Agent They Top Up Their Promo Float.
                  </>
                ) : (
                  <>
                    Send Chips, Diamonds Or Promo Funds To Any Member Of The Union.
                    {walletKey === 'bbj' &&
                      ' BBJ Funds Are Reserved For Jackpots, So Chips Sent Here Draw On The Main Bank.'}
                  </>
                )}
              </p>
            </div>
            {(readOnly || mode === 'ledger') && (
              <button className="cbc-x" onClick={requestClose} aria-label="Close" disabled={busy}>
                Close
              </button>
            )}
          </div>

          <div className="cbc-bank">
            <span>{walletLabel} Balance</span>
            <strong aria-live="polite">{money(liveBalance)}</strong>
            <em className="cbc-bank-sub">Union Wallet</em>
          </div>

          {!readOnly && (
            <div className="cbc-tabs" role="tablist">
              {(['send', 'pull', 'ledger'] as Mode[]).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? 'cbc-tab cbc-tab--on' : 'cbc-tab'}
                  onClick={() => {
                    setMode(m);
                    setTarget(null);
                    setNotice(null);
                  }}
                >
                  {m === 'send' ? 'Send' : m === 'pull' ? 'Pull (Clawback)' : 'Ledger'}
                </button>
              ))}
            </div>
          )}

          <div className="cbc-body">
            {/* Two guards on the outbound flow, both on readOnly: the spin
              reserve is not a send source and must never grow a picker or a
              send button (tests/config/spinReserveWalletView.test.ts). */}
            {!readOnly && (
              <>
                {mode !== 'ledger' && (
                  <>
                    {mode === 'send' && (
                      <div className="cbc-field">
                        <label className="cbc-label">Send</label>
                        <div className="cbc-seg">
                          {(['chips', 'diamonds', 'promo'] as SendKind[]).map((k) => (
                            <button
                              key={k}
                              className={kind === k ? 'cbc-seg-on' : ''}
                              aria-pressed={kind === k}
                              onClick={() => setKind(k)}
                            >
                              {k === 'chips' ? 'Chips' : k === 'diamonds' ? 'Diamonds' : 'Promo'}
                            </button>
                          ))}
                        </div>
                        <div className="cbc-blurb">
                          {kind === 'promo'
                            ? 'Promo Chips. A Club Receives Them In Its Promo Wallet; A Player As Cash; An Agent In Their Promo Float.'
                            : kind === 'diamonds'
                              ? 'Diamonds Go To A Member. A Club Has No Diamond Wallet.'
                              : isPromo
                                ? 'Chips Drawn From The Promo Wallet. A Player Receives Them As Cash.'
                                : walletKey === 'rake'
                                  ? 'Chips Drawn From The Rake Wallet, To A Member Only.'
                                  : 'Chips Drawn From The Union Bank. A Club Receives Them In Its Club Bank.'}
                        </div>
                      </div>
                    )}

                    <div className="cbc-field">
                      <label className="cbc-label" htmlFor="uwm-search">
                        {mode === 'pull' ? 'Pull From Club' : 'Recipient'}
                      </label>
                      <input
                        id="uwm-search"
                        className="cbc-input"
                        placeholder="Search Clubs Or Members…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search Clubs Or Members"
                      />
                      <div className="cbc-list uwm-list">
                        {loading ? (
                          <div className="cbc-empty">Loading Directory…</div>
                        ) : directoryError ? (
                          <div className="cbc-empty cbc-empty--bad" role="alert">
                            {directoryError}
                            <button
                              type="button"
                              className="cbc-more"
                              onClick={() => setDirectoryReload((value) => value + 1)}
                            >
                              Retry Directory
                            </button>
                          </div>
                        ) : filtered.clubs.length === 0 && filtered.roster.length === 0 ? (
                          <div className="cbc-empty">No Targets Match.</div>
                        ) : (
                          <>
                            {filtered.clubs.map((c) => {
                              const on = target?.type === 'club' && target.data.id === c.id;
                              const blocked =
                                (mode === 'send' && route.kind === 'refused') ||
                                (mode === 'pull' && pullRoute.kind === 'refused');
                              return (
                                <button
                                  key={`club-${c.id}`}
                                  onClick={() => !blocked && setTarget({ type: 'club', data: c })}
                                  aria-pressed={on}
                                  aria-disabled={blocked ? true : undefined}
                                  title={blocked ? (clubRefusal ?? undefined) : undefined}
                                  className={
                                    blocked
                                      ? 'cbc-member cbc-member--blocked'
                                      : on
                                        ? mode === 'pull'
                                          ? 'cbc-member cbc-member--on uwm-member--pull'
                                          : 'cbc-member cbc-member--on'
                                        : 'cbc-member'
                                  }
                                >
                                  <div className="cbc-member-info">
                                    <span className="cbc-member-name">{c.name}</span>
                                    <span className="cbc-member-id">
                                      {mode === 'pull'
                                        ? pullRoute.kind === 'promo'
                                          ? 'Pull From The Club Promo Wallet'
                                          : pullRoute.kind === 'bank'
                                            ? 'Pull From The Club Bank'
                                            : 'Not Available From Here'
                                        : route.kind === 'promo'
                                          ? 'Into The Club Promo Wallet'
                                          : route.kind === 'bank'
                                            ? 'Into The Club Bank'
                                            : 'Not Available From Here'}
                                    </span>
                                  </div>
                                  <span className="uwm-club-tag">
                                    {(mode === 'send' && route.kind === 'promo') ||
                                    (mode === 'pull' && pullRoute.kind === 'promo')
                                      ? 'CLUB PROMO WALLET'
                                      : 'CLUB BANK'}
                                  </span>
                                </button>
                              );
                            })}
                            {filtered.roster.slice(0, 200).map((r) => {
                              const isDisabled = mode === 'pull';
                              const on =
                                target?.type === 'member' && target.data.user_id === r.user_id;
                              return (
                                <button
                                  key={`${r.user_id}-${r.club_id}`}
                                  onClick={() =>
                                    !isDisabled && setTarget({ type: 'member', data: r })
                                  }
                                  disabled={isDisabled}
                                  title={
                                    isDisabled
                                      ? 'Member Clawbacks Must Be Performed By The Club Owner.'
                                      : undefined
                                  }
                                  aria-pressed={on}
                                  className={
                                    isDisabled
                                      ? 'cbc-member cbc-member--blocked'
                                      : on
                                        ? 'cbc-member cbc-member--on'
                                        : 'cbc-member'
                                  }
                                >
                                  <div
                                    className="cbc-member-avatar"
                                    style={{ backgroundImage: `url(${r.avatar_url || ''})` }}
                                  />
                                  <div className="cbc-member-info">
                                    <span className="cbc-member-name">
                                      {r.display_name || r.username || r.user_id.slice(0, 8)}
                                    </span>
                                    <span className="cbc-member-id">{r.club_name || ''}</span>
                                  </div>
                                  <span
                                    className={`cbc-member-role uwm-role uwm-role--${r.member_role || 'member'}`}
                                  >
                                    {(r.member_role || 'member').replace('_', ' ').toUpperCase()}
                                  </span>
                                </button>
                              );
                            })}
                          </>
                        )}
                      </div>
                      {clubRefusal && filtered.clubs.length > 0 && (
                        <div className="cbc-blurb">{clubRefusal}</div>
                      )}
                    </div>

                    <div className="cbc-field">
                      <label className="cbc-label" htmlFor="uwm-amount">
                        Amount
                      </label>
                      <div className="uwm-amount-row">
                        <input
                          id="uwm-amount"
                          className="cbc-input"
                          type="number"
                          inputMode="decimal"
                          min="1"
                          placeholder="Amount"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          aria-label={mode === 'pull' ? 'Chips To Pull Back' : 'Amount To Send'}
                        />
                      </div>
                      {Number(amount) > 0 && target && (
                        <div className="cbc-blurb">
                          {mode === 'pull'
                            ? `Pulling ${money(Number(amount))}. This Wallet Would Hold ${money(liveBalance + Number(amount))} Afterwards.`
                            : kind === 'diamonds'
                              ? `Sending ${fmt(Number(amount))} Diamonds.`
                              : `Sending ${money(Number(amount))}. This Wallet Would Hold ${money(liveBalance - Number(amount))} Afterwards.`}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {mode === 'ledger' && (
                  <>
                    {ledgerError && <div className="cbc-empty cbc-empty--bad">{ledgerError}</div>}
                    {!ledgerError && ledgerTotals && (
                      <div className="cbc-totals">
                        <div>
                          <span>Received</span>
                          <strong className="cbc-in">{money(ledgerTotals.in)}</strong>
                        </div>
                        <div>
                          <span>Sent Out</span>
                          <strong className="cbc-out">{money(ledgerTotals.out)}</strong>
                        </div>
                        <div>
                          <span>Net</span>
                          <strong>{money(ledgerTotals.net)}</strong>
                        </div>
                      </div>
                    )}
                    {!ledgerError && (
                      <div className="cbc-ledger-head">
                        <span>
                          {ledgerTotal.toLocaleString('en-US')} Entries · {walletLabel}
                        </span>
                      </div>
                    )}
                    {!ledgerError &&
                      ledger.map((r) => {
                        const inbound = r.direction === 'in';
                        const other = r.counterparty_name || null;
                        return (
                          <div key={r.id} className={inbound ? 'cbc-tx cbc-tx--in' : 'cbc-tx'}>
                            <div className="cbc-tx-top">
                              <span className="cbc-tx-type">{titleCase(r.category)}</span>
                              <span
                                className={
                                  inbound ? 'cbc-tx-amount cbc-in' : 'cbc-tx-amount cbc-out'
                                }
                              >
                                {`${inbound ? '+' : '-'}${money(r.amount)}`}
                              </span>
                            </div>
                            <div className="cbc-tx-mid">
                              <span>
                                {other ? (inbound ? `From ${other}` : `To ${other}`) : walletLabel}
                              </span>
                              <span className="cbc-tx-when">{when(r.created_at)}</span>
                            </div>
                            <div className="cbc-tx-foot">
                              {r.notes && <span>{r.notes}</span>}
                              {r.actor_name && <span>By {r.actor_name}</span>}
                              {r.balance_after != null && (
                                <span>Wallet After {money(Number(r.balance_after))}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    {!ledgerError && !ledgerLoading && ledger.length === 0 && (
                      <div className="cbc-empty">
                        Nothing Has Moved Through This Wallet Yet. Every Send, Sweep And Settlement
                        Writes A Row Here.
                      </div>
                    )}
                    {ledgerLoading && <div className="cbc-empty">Loading Ledger…</div>}
                    {!ledgerError && !ledgerLoading && ledger.length < ledgerTotal && (
                      <button className="cbc-more" onClick={() => void loadLedger(ledger.length)}>
                        Load More
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {readOnly && (
              <div>
                <div className="cbc-label" style={{ marginBottom: 6 }}>
                  RESERVE LEDGER
                </div>
                {reserveLedger.length === 0 ? (
                  <div className="cbc-empty">
                    Nothing Has Moved Through This Wallet Yet. Seeding A Pool Or Funding The Reserve
                    Writes A Row Here.
                  </div>
                ) : (
                  reserveLedger.map((r) => {
                    const inbound = r.direction === 'credit';
                    return (
                      <div key={r.id} className={inbound ? 'cbc-tx cbc-tx--in' : 'cbc-tx'}>
                        <div className="cbc-tx-top">
                          <span className="cbc-tx-type">{r.notes || titleCase(r.tx_type)}</span>
                          <span
                            className={inbound ? 'cbc-tx-amount cbc-in' : 'cbc-tx-amount cbc-out'}
                          >
                            {`${inbound ? '+' : '-'}${money(r.amount)}`}
                          </span>
                        </div>
                        <div className="cbc-tx-mid">
                          <span className="cbc-tx-when">{when(r.created_at)}</span>
                          {r.balance_after != null && <span>Balance {money(r.balance_after)}</span>}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {notice && (
              <div
                role={notice.ok ? 'status' : 'alert'}
                className={notice.ok ? 'uwm-notice uwm-notice--ok' : 'uwm-notice uwm-notice--bad'}
              >
                {notice.text}
              </div>
            )}
          </div>
        </CashierConsoleSurface>
      </div>
    </div>
  );
}

export default UnionWalletModal;
