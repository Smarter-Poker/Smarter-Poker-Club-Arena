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
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { readUnionDirectory } from '../../services/unionDirectory';
import { useAuthUser } from '../../hooks/useAuthUser';
import { reportError } from '../../utils/errorReporter';
import { fmt, formatWalletChips } from '../../utils/format';
import { unionApi } from '../../services/UnionApiService';
import { classifyCashierRpcFailure } from '../../services/CashierResilience';
import { isPlatformFrozenError, PLATFORM_FROZEN_MESSAGE } from '../../utils/platformFrozen';
import {
  acknowledgeDurableUnionWalletOperation,
  reserveDurableUnionWalletOperation,
  unionWalletIntentSignature,
  type UnionWalletIntentScope,
} from '../../services/UnionWalletRecovery';
import {
  clubSendRoute,
  clubPullRoute,
  UNION_WALLET_COLUMN,
  type UnionSendKind,
} from './unionWalletRoutes';
import { SpadeConsole } from '../console/SpadeConsole';
import { WalletDesk, WalletDeskHeading, WalletDeskRow } from '../wallet/WalletDesk';
import '../wallet/WalletDesk.css';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import {
  pullableFrom,
  readUnionClubBalances,
  type UnionClubBalance,
} from '../../services/unionClubBalances';
import './UnionWalletModal.css';

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
/**
 * HOW AN AMOUNT MAY BE SPELLED (launch audit D-07 / D-15). The RPC takes
 * hundredths from a member send, whole chips from a club send and whole
 * diamonds; `Number()` alone accepted "10.005" (sent verbatim), "1e3" (a
 * thousand the typist never saw written out) and anything over the balance
 * (the plate lit, the server refused). The spelling is checked before the
 * value is.
 */
const CENT_AMOUNT = /^\d+(\.\d{1,2})?$/;
const WHOLE_AMOUNT = /^\d+$/;

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

/* "Promo To Club" from "promo_to_club". Popup and label casing law.
 *
 * A LOCAL COPY OF THIS LIVED HERE UNTIL 2026-09-14 and it lower-cased the tail
 * of every word, so the ledger printed "Bbj Sweep" and "Mtt Fee" for
 * `bbj_sweep` and `mtt_fee`. `enumToTitleCase` is the house transform and it
 * knows the product's initialisms, which is exactly why there may only be one
 * of these (src/utils/titleCase.ts). */

/**
 * The union-wallet API refuses a note carrying ; ' " or a backslash
 * (SafeNotes in the World Hub contract). A club called "Dan's Room" would
 * otherwise turn a valid send into a 400 with nothing on screen to say why.
 */
const apiNote = (s: string) => s.replace(/[;'"\\]/g, '').slice(0, 500);

const definitiveRefusal = (message: string): Error & { definitive: true } =>
  Object.assign(new Error(message), { definitive: true as const });

/**
 * A RESOLVED `error` IS NOT ALWAYS A REFUSAL (cashier launch round 2,
 * 2026-10-09; .agent-logs/C5-probe-union-transport). supabase-js does not
 * reject when fetch() fails: it resolves `{ data: null, error: { code: '' },
 * status: 0 }`, and a gateway 5xx, a 408/409/425/429 or an abort can arrive
 * after the function committed. Every one of those used to be thrown as
 * `definitiveRefusal`, which retired the operation id, so the operator's retry
 * of a send the server had already made went out under a NEW id and moved the
 * money twice. Only a SQL refusal carried on a 4xx is definitive (the shared
 * cashier classifier, launch brief rule 8); anything else keeps the id, and the
 * server answers the repeat with the original receipt (`replayed`).
 */
const UNION_OUTCOME_UNKNOWN =
  'Outcome Not Yet Confirmed. Repeat The Same Move To Confirm It; It Cannot Run Twice.';
const rpcFailure = (
  error: { message?: string } | null,
  status: number | null | undefined,
  refusal: string
): Error =>
  // Maintenance break refusal (2026-10-16): name the break, but keep the
  // operation id (not `definitive`), so a repeat can only ever replay.
  isPlatformFrozenError(error)
    ? new Error(PLATFORM_FROZEN_MESSAGE)
    : classifyCashierRpcFailure(error, status) === 'refused'
      ? definitiveRefusal(error?.message || refusal)
      : new Error(UNION_OUTCOME_UNKNOWN);

/** Ledger money: whole chips print whole (5,000), cents print only when held (32,482.58). */
const money = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

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
  /** The amount sheet over the desk: open for a send or a pull, else closed. */
  const [sheetOpen, setSheetOpen] = useState(false);
  /** The union's own logo leads the desk, as the club's leads the Cashier. */
  const [unionLogo, setUnionLogo] = useState<string | null>(null);
  const [clubs, setClubs] = useState<Array<{ id: string; name: string }>>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryReload, setDirectoryReload] = useState(0);
  /** Club Bank / Promo balances by club id (union owner and union leads only). */
  const [clubBalances, setClubBalances] = useState<Map<string, UnionClubBalance>>(
    () => new Map()
  );
  const [balanceReload, setBalanceReload] = useState(0);
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
  /** Newest ledger request wins (launch audit D-06): a page still travelling
      for the previous wallet must not paint under the next wallet's eyebrow. */
  const ledgerSeq = useRef(0);

  const chipSource = walletKey === 'rake' ? 'rake' : walletKey === 'promo' ? 'promo' : 'chips';

  const requestClose = useCallback(() => {
    if (busyRef.current) {
      setNotice({ ok: false, text: 'Wait For The Current Money Move To Finish.' });
      return;
    }
    onClose();
  }, [onClose]);

  /** Escape and the sheet's Back plate close the amount sheet first, then the desk. */
  const closeSheet = useCallback(() => {
    if (busyRef.current) {
      setNotice({ ok: false, text: 'Wait For The Current Money Move To Finish.' });
      return;
    }
    setSheetOpen(false);
    setNotice(null);
    setAmount('');
  }, []);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sheetOpenRef.current) closeSheet();
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    /* The page behind stops scrolling while the sheet is up, as every other
       money dialog already does (launch audit D-11). */
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, requestClose, closeSheet]);

  useEffect(() => {
    if (!isOpen || !unionId) return;
    let live = true;
    void supabase
      .from('clubs')
      .select('logo_url')
      .eq('id', unionId)
      .limit(1)
      .then(({ data, error }) => {
        if (!live) return;
        if (error) {
          reportError(error, 'UnionWalletModal.union_logo_load_failed');
          return;
        }
        const row = (Array.isArray(data) ? data[0] : null) as { logo_url?: string | null } | null;
        setUnionLogo(row?.logo_url || null);
      });
    return () => {
      live = false;
    };
  }, [isOpen, unionId]);

  /* Tab stays inside the sheet, focus lands on its first control and returns
     to the wallet row that opened it (launch audit D-11). */
  const panelRef = useFocusTrap<HTMLDivElement>(isOpen);
  /* The amount sheet holds Tab on its own while it is up: the desk behind it
     is inert, and the sheet's trap sits on top of the desk's (the shared hook
     answers only the newest trap), so Tab never walks back onto covered rows.
     Closing it returns focus to the dock word that opened it. */
  const sheetTrapRef = useFocusTrap<HTMLDivElement>(
    isOpen && walletKey !== 'spin_reserve' && sheetOpen
  );

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
    setSheetOpen(false);
    setLiveBalance(balance);
    setKind(walletKey === 'promo' ? 'promo' : 'chips');
    setLedger([]);
    setLedgerTotal(0);
    setLedgerTotals(null);
    setLedgerError(null);
    ++ledgerSeq.current;

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
      const reserveVersion = directoryLoadVersion;
      return () => {
        if (isCurrent()) ++reserveVersion.current;
      };
    }
    setReserveLedger([]);

    setLoading(true);
    void Promise.all([
      /* fn_union_player_directory, read past the API's 1,000-row cap. */
      readUnionDirectory<RosterRow>(unionId),
      // Read identity only: club financial columns are intentionally protected.
      supabase.from('union_clubs').select('club_id, clubs:club_id(name)').eq('union_id', unionId),
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

    const version = directoryLoadVersion;
    return () => {
      if (isCurrent()) ++version.current;
    };
    /* `balance` is deliberately left out (see above); `readOnly` is derived
       from `walletKey`, which is a dependency. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, unionId, walletKey, user?.id, directoryReload]);

  /* CLUB BALANCES (Dan, 2026-10-21). Read separately from the directory so a
     refused or failed balance read never hides the clubs themselves: the rows
     still load and the figure is simply left off, never shown as 0. */
  useEffect(() => {
    if (!isOpen || readOnly || !unionId) {
      setClubBalances(new Map());
      return;
    }
    let live = true;
    readUnionClubBalances(unionId)
      .then((map) => {
        if (live) setClubBalances(map);
      })
      .catch((error) => {
        reportError(error, 'UnionWalletModal.club_balances_load_failed');
        if (live) setClubBalances(new Map());
      });
    return () => {
      live = false;
    };
  }, [isOpen, readOnly, unionId, directoryReload, balanceReload]);

  /* A confirmed movement changes a club's balance: read it again. */
  useEffect(() => {
    if (notice?.ok) setBalanceReload((value) => value + 1);
  }, [notice]);

  /**
   * THE LEDGER TAB. fn_promo_wallet_ledger scope 'union' reads
   * union_wallet_transactions for the open wallet's column, newest first, with
   * the club and the person on each row named. Same RPC the club promo wallet
   * uses, so a chip that leaves here can be found there under the same words.
   */
  const loadLedger = useCallback(
    async (offset: number) => {
      const seq = ++ledgerSeq.current;
      const current = () => seq === ledgerSeq.current;
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
        if (!current()) return;
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
        if (current()) setLedgerError('Could Not Load The Ledger.');
      } finally {
        if (current()) setLedgerLoading(false);
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

  /**
   * The sentence that refuses the typed amount, or null when it may go. One
   * reading for the plate, the blurb and the send itself, so the plate can
   * never be lit for a figure the send would refuse.
   *  - diamonds and club sends move in whole units (the union-wallet API
   *    contract FLOORS a club amount: 250.5 would leave as 250 while this
   *    screen subtracted 250.5);
   *  - a member send is hundredths, spelled plainly (no exponent, no third
   *    decimal, which the RPC would otherwise take verbatim);
   *  - a send never exceeds the wallet, so "Would Hold" is never negative.
   */
  const amountRefusal = useMemo((): string | null => {
    const text = amount.trim();
    if (text === '' || !target || mode === 'ledger') return null;
    const amt = Number(text);
    if (!Number.isFinite(amt) || amt <= 0) return 'Enter An Amount Greater Than Zero.';
    if (kind === 'diamonds') {
      if (!WHOLE_AMOUNT.test(text)) return 'Diamonds Must Be A Whole Number.';
    } else if (target.type === 'club') {
      if (!WHOLE_AMOUNT.test(text)) return 'Club Sends Move In Whole Chips.';
    } else if (!CENT_AMOUNT.test(text)) {
      return 'Enter An Amount In Whole Cents.';
    }
    if (mode === 'send' && amt > liveBalance)
      return `This Wallet Only Holds ${formatWalletChips(liveBalance)}.`;
    if (mode === 'pull' && target.type === 'club') {
      const held = clubBalances.get(target.data.id);
      if (held) {
        const promo = clubPullRoute(walletKey).kind === 'promo';
        const most = pullableFrom(held, promo);
        if (amt > most)
          return promo
            ? `This Club Promo Wallet Only Holds ${formatWalletChips(most)}.`
            : held.floor > 0
              ? `At Most ${formatWalletChips(most)} Can Be Pulled. The ${formatWalletChips(held.floor)} Opening Grant Stays In The Club.`
              : `This Club Bank Only Holds ${formatWalletChips(most)}.`;
      }
    }
    return null;
  }, [amount, target, mode, kind, liveBalance, clubBalances, walletKey]);

  const send = useCallback(async () => {
    const text = amount.trim();
    const amt = Number(text);
    if (
      !target ||
      mode === 'ledger' ||
      !Number.isFinite(amt) ||
      amt <= 0 ||
      busy ||
      busyRef.current
    )
      return;
    if (amountRefusal) {
      setNotice({ ok: false, text: amountRefusal });
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
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    let opId: string | null = null;
    const directoryVersion = directoryLoadVersion.current;
    const rpc = (name: string, args: Record<string, unknown>) => supabase.rpc(name, args);
    const acknowledge = async () => {
      if (!opId) return;
      try {
        await acknowledgeDurableUnionWalletOperation(intentScope, opId, rpc);
      } catch (error) {
        // Keep the server intent for safe replay. A confirmed movement stays
        // confirmed even if its acknowledgement response is interrupted.
        reportError(error, 'UnionWalletModal.intent_acknowledgement_failed');
      }
    };
    try {
      opId = await reserveDurableUnionWalletOperation(intentScope, rpc);
      if (directoryVersion !== directoryLoadVersion.current) return;
      if (mode === 'send') {
        if (target.type === 'member') {
          const { data, error, status } = await supabase.rpc('fn_union_send_to_member', {
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
          if (error) throw rpcFailure(error, status, 'Union Send Failed');
          if (!res.success) throw definitiveRefusal(res.error || 'Union Send Failed');
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
          const {
            data: cbRes,
            error: cbErr,
            status: cbStatus,
          } = await supabase.rpc(
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
          if (cbErr) throw rpcFailure(cbErr, cbStatus, 'Clawback Failed');
          const cb = (cbRes ?? {}) as {
            success?: boolean;
            error?: string;
            duplicate?: boolean;
            promo_after?: number;
            union_balance?: number;
          };
          if (cb.success === false) {
            if (cb.duplicate) {
              await acknowledge();
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
            const msg = cb.error || 'Clawback Failed';
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
      await acknowledge();
      setAmount('');
      try {
        onSent?.();
      } catch (callbackError) {
        // Refresh failures do not turn a confirmed money movement into a
        // failure banner or invite the operator to submit it again.
        reportError(callbackError, 'UnionWalletModal.on_sent_failed');
      }
    } catch (err: any) {
      if (err?.definitive === true) await acknowledge();
      reportError(err, 'UnionWalletModal.action_failed');
      setNotice({
        ok: false,
        // Maintenance break refusal is definitive (2026-10-16).
        text: isPlatformFrozenError(err)
          ? PLATFORM_FROZEN_MESSAGE
          : err.message || 'The Action Was Refused.',
      });
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
    amountRefusal,
  ]);

  if (!isOpen) return null;

  const isPromo = walletKey === 'promo';
  const sendDisabled =
    !target ||
    !(Number(amount) > 0) ||
    Boolean(amountRefusal) ||
    !user?.id ||
    loading ||
    Boolean(directoryError) ||
    busy ||
    (mode === 'send' && target.type === 'club' && route.kind === 'refused') ||
    (mode === 'pull' && target.type === 'club' && pullRoute.kind === 'refused');

  /* ═══════════════════════════════════════════════════════════════════════
     ON THE WALLET DESK (Dan 2026-10-16)
     ═══════════════════════════════════════════════════════════════════════
     "When you click the union bank wallet, promo wallet or diamond wallet,
     they should look feel and function like this cashier functionality.
     Remove the bulky generic frames." Re-rendered, not rewritten: every
     route, guard, op-id reservation, RPC, refusal sentence and accessible
     name above this line is the one that was here.

     The wallet opens as the Cashier does: the identity row (the wallet's
     own art, its name, its balance), the directory of clubs and members as
     hairline rows you tap to select, and the painted action dock with
     Pull Back | Ledger | Send Out under a centred selection line. The
     amount is asked for on a riveted sheet, as the Cashier's Send Out asks
     for it on its own console. The riveted base always paints both plates,
     so the sheet carries Back on steel and the confirm on blue glass. */
  const verb = mode === 'pull' ? 'Pull' : 'Send';
  const targetName =
    target == null
      ? null
      : target.type === 'club'
        ? titleCase(target.data.name)
        : titleCase(target.data.display_name || target.data.username || 'Member');
  /* The visible word stays short so it cannot outgrow the painted plate; the
     accessible name carries the whole sentence, which is what the tests and a
     screen reader read. The visible word is contained in it either way. */
  const confirmLabel = busy ? (mode === 'send' ? 'Sending' : 'Pulling') : verb;
  const confirmName = !target
    ? `${verb} - Pick A Member Or Club`
    : mode === 'send'
      ? `Send To ${targetName}`
      : `Pull From ${target.type === 'club' ? targetName : 'Target'}`;
  const moreLedger = !readOnly && mode === 'ledger' && !ledgerError && ledger.length < ledgerTotal;

  const art = unionLogo;

  /** A club can be picked when this wallet has a send OR a pull route to clubs. */
  const clubsBlocked = route.kind === 'refused' && pullRoute.kind === 'refused';
  const pullAvailable =
    !readOnly && target?.type === 'club' && pullRoute.kind !== 'refused' && !directoryError;
  const sendOutReady = !readOnly && Boolean(target) && !directoryError && !loading && !busy;
  const openSheet = (next: 'send' | 'pull') => {
    setMode(next);
    setNotice(null);
    setAmount('');
    setSheetOpen(true);
  };
  const dockLine = readOnly
    ? 'Read Only'
    : mode === 'ledger'
      ? `${walletLabel} Ledger`
      : target
        ? `${targetName} Selected`
        : 'Tap A Club Or Member To Select';

  /* PORTALED TO <body> (2026-10-17). Rendered in place, the desk lived inside
     the lobby's stacking context and the fixed bottom nav and global header
     painted over it: the dock's Pull Back, Ledger and Send Out could not be
     tapped. On <body> it is one full-screen layer over the whole app. */
  return createPortal(
    /* The shared focus trap holds Tab inside the desk and its sheet, moves
       focus in and returns it to the wallet tile that opened it. */
    <div ref={panelRef} className="wdesk__trap">
      <WalletDesk
        ariaLabel={`${walletLabel} Cashier`}
        sheet={
          !readOnly &&
          sheetOpen && (
            <div className="uwm-overlay" onClick={closeSheet}>
              <div ref={sheetTrapRef} className="uwm-dialog" onClick={(e) => e.stopPropagation()}>
                <SpadeConsole
                  onClose={busy ? undefined : closeSheet}
                  className="uwm-console"
                  family="riveted"
                  eyebrow={walletLabel}
                  title={formatWalletChips(liveBalance)}
                  pill={mode === 'pull' ? 'Pull Back' : 'Send Out'}
                  pillInk="blue"
                  foot="plates"
                  plates={{
                    secondary: {
                      label: 'Back',
                      ink: 'silver',
                      onClick: closeSheet,
                      disabled: busy,
                      'aria-label': 'Back',
                    },
                    primary: {
                      label: confirmLabel,
                      ink: sendDisabled ? 'muted' : 'white',
                      onClick: () => void send(),
                      disabled: sendDisabled,
                      'aria-label': confirmName,
                    },
                  }}
                >
                  <div className="uwm-field">
                    <span className="uwm-label sc-ink--blue">
                      {mode === 'pull' ? 'Pull From' : 'To'}
                    </span>
                    <span className="uwm-target-name sc-ink--silver">
                      {targetName}
                      {target?.type === 'member' && target.data.club_name
                        ? ` · ${titleCase(target.data.club_name)}`
                        : target?.type === 'club'
                          ? mode === 'pull'
                            ? pullRoute.kind === 'promo'
                              ? ' · Club Promo Wallet'
                              : ' · Club Bank'
                            : route.kind === 'promo'
                              ? ' · Club Promo Wallet'
                              : ' · Club Bank'
                          : ''}
                    </span>
                  </div>

                  {target?.type === 'club' &&
                    (() => {
                      const held = clubBalances.get(target.data.id);
                      if (!held) return null;
                      const promo =
                        mode === 'pull' ? pullRoute.kind === 'promo' : route.kind === 'promo';
                      const pullable = pullableFrom(held, promo);
                      return (
                        <div className="uwm-field">
                          <span className="uwm-label sc-ink--blue">
                            {promo ? 'Club Promo Wallet' : 'Club Bank Balance'}
                          </span>
                          <span className="uwm-target-name sc-ink--silver">
                            {formatWalletChips(promo ? held.promo : held.bank)}
                          </span>
                          {mode === 'pull' && !promo && held.floor > 0 && (
                            <div className="uwm-blurb">
                              {`Pullable ${formatWalletChips(pullable)}. The ${formatWalletChips(held.floor)} Opening Grant Stays In The Club.`}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                  {mode === 'send' && (
                    <div className="uwm-field">
                      <span className="uwm-label sc-ink--blue">Send</span>
                      <div className="uwm-kinds" role="group" aria-label="What To Send">
                        {(['chips', 'diamonds', 'promo'] as SendKind[]).map((k) => (
                          <button
                            key={k}
                            type="button"
                            className={
                              kind === k ? 'uwm-kind sc-ink--white' : 'uwm-kind sc-ink--muted'
                            }
                            aria-pressed={kind === k}
                            onClick={() => setKind(k)}
                          >
                            {k === 'chips' ? 'Chips' : k === 'diamonds' ? 'Diamonds' : 'Promo'}
                          </button>
                        ))}
                      </div>
                      <div className="uwm-blurb">
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
                      {clubRefusal && target?.type === 'club' && (
                        <div className="uwm-blurb sc-ink--red">{clubRefusal}</div>
                      )}
                    </div>
                  )}

                  <div className="uwm-field">
                    <label className="uwm-label sc-ink--blue" htmlFor="uwm-amount">
                      Amount
                    </label>
                    <input
                      id="uwm-amount"
                      className="uwm-input uwm-input--amount"
                      type="number"
                      inputMode="decimal"
                      min="1"
                      placeholder="Amount"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-label={mode === 'pull' ? 'Chips To Pull Back' : 'Amount To Send'}
                    />
                    {amount.trim() !== '' && target && amountRefusal && (
                      <div className="uwm-blurb sc-ink--red" role="alert">
                        {amountRefusal}
                      </div>
                    )}
                    {Number(amount) > 0 && target && !amountRefusal && (
                      <div className="uwm-blurb">
                        {mode === 'pull'
                          ? `Pulling ${money(Number(amount))} From ${targetName}. This Wallet Would Hold ${formatWalletChips(liveBalance + Number(amount))} Afterwards.`
                          : kind === 'diamonds'
                            ? `Sending ${fmt(Number(amount))} Diamonds To ${targetName}.`
                            : `Sending ${money(Number(amount))} To ${targetName}. This Wallet Would Hold ${formatWalletChips(liveBalance - Number(amount))} Afterwards.`}
                      </div>
                    )}
                  </div>

                  {notice && (
                    <div
                      role={notice.ok ? 'status' : 'alert'}
                      className={notice.ok ? 'uwm-notice sc-ink--green' : 'uwm-notice sc-ink--red'}
                    >
                      {notice.text}
                    </div>
                  )}
                </SpadeConsole>
              </div>
            </div>
          )
        }
        art={art}
        name={walletLabel}
        line={`${formatWalletChips(liveBalance)} Chips`}
        onClose={requestClose}
        closeDisabled={busy}
        dockLine={dockLine}
        actions={
          /* Read only: the dock says so on its line and prints no control.
             A permanently disabled button repeating the line is a dead control. */
          readOnly
            ? []
            : [
                {
                  label: 'Pull Back',
                  lit: true,
                  onClick: () => openSheet('pull'),
                  disabled: !pullAvailable || busy,
                  'aria-label':
                    target?.type === 'club'
                      ? `Pull Back From ${targetName}`
                      : 'Pull Back - Pick A Club',
                },
                {
                  label: mode === 'ledger' ? 'Recipients' : 'Ledger',
                  pressed: mode === 'ledger',
                  onClick: () => {
                    setSheetOpen(false);
                    setNotice(null);
                    setMode((m) => (m === 'ledger' ? 'send' : 'ledger'));
                  },
                  disabled: busy,
                  'aria-label': mode === 'ledger' ? 'Show Recipients' : 'Ledger',
                },
                {
                  label: 'Send Out',
                  onClick: () => openSheet('send'),
                  disabled: !sendOutReady,
                  'aria-label': target
                    ? `Send Out To ${targetName}`
                    : 'Send Out - Pick A Member Or Club',
                },
              ]
        }
      >
        {/* The balance is printed in the identity row; this is the same figure
          in a polite live region, so a screen reader hears the wallet move. */}
        <span className="wdesk__live" aria-live="polite">
          {walletLabel} Balance {formatWalletChips(liveBalance)}
        </span>

        {/* Two guards on the outbound flow, both on readOnly: the spin reserve
          is not a send source and must never grow a picker or a send
          (tests/config/spinReserveWalletView.test.ts). */}
        {readOnly && (
          <>
            <WalletDeskHeading title="Reserve Ledger" meta={`${reserveLedger.length} Entries`} />
            <p className="wdesk__empty">
              The Capital Every Spin Bonus Pool Is Seeded From, And Every Spin Prize Is Paid Out Of.
              It Is Not A Send Source: Add Funds With Fund Spin Reserve On The Wallet Tab.
            </p>
            <div className="wdesk__list">
              {reserveLedger.length === 0 ? (
                <div className="wdesk__empty">
                  Nothing Has Moved Through This Wallet Yet. Seeding A Pool Or Funding The Reserve
                  Writes A Row Here.
                </div>
              ) : (
                reserveLedger.map((r) => {
                  const inbound = r.direction === 'credit';
                  return (
                    <WalletDeskRow
                      key={r.id}
                      name={r.notes ? titleCase(r.notes) : enumToTitleCase(r.tx_type)}
                      sub={`${when(r.created_at)}${r.balance_after != null ? ` · Balance ${formatWalletChips(r.balance_after)}` : ''}`}
                      figure={
                        <span className={inbound ? 'wdesk__in' : 'wdesk__out'}>
                          {`${inbound ? '+' : '-'}${money(r.amount)}`}
                        </span>
                      }
                    />
                  );
                })
              )}
            </div>
          </>
        )}

        {!readOnly && (
          <>
            {mode !== 'ledger' && (
              <>
                <WalletDeskHeading
                  title="Recipients"
                  meta={
                    loading
                      ? 'Loading'
                      : `${filtered.clubs.length.toLocaleString('en-US')} Clubs · ${filtered.roster.length.toLocaleString('en-US')} Members`
                  }
                />
                <label className="wdesk__search">
                  <input
                    id="uwm-search"
                    placeholder="Search Clubs Or Members"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search Clubs Or Members"
                  />
                </label>
                <div className="wdesk__list">
                  {loading ? (
                    <div className="wdesk__empty">Loading Directory</div>
                  ) : directoryError ? (
                    <div className="wdesk__empty wdesk__empty--bad" role="alert">
                      {directoryError}{' '}
                      <button
                        type="button"
                        className="wdesk__more"
                        onClick={() => setDirectoryReload((value) => value + 1)}
                      >
                        Retry Directory
                      </button>
                    </div>
                  ) : filtered.clubs.length === 0 && filtered.roster.length === 0 ? (
                    <div className="wdesk__empty">No Targets Match.</div>
                  ) : (
                    <>
                      {filtered.clubs.map((c) => {
                        const on = target?.type === 'club' && target.data.id === c.id;
                        return (
                          <WalletDeskRow
                            key={`club-${c.id}`}
                            name={titleCase(c.name)}
                            sub={
                              route.kind === 'promo'
                                ? 'Into The Club Promo Wallet'
                                : route.kind === 'bank'
                                  ? 'Into The Club Bank'
                                  : pullRoute.kind !== 'refused'
                                    ? 'Pull Back Only From Here'
                                    : 'Not Available From Here'
                            }
                            tag={
                              route.kind === 'promo' || pullRoute.kind === 'promo'
                                ? 'Club Promo Wallet'
                                : 'Club Bank'
                            }
                            figure={(() => {
                              const held = clubBalances.get(c.id);
                              if (!held) return undefined;
                              return formatWalletChips(
                                route.kind === 'promo' || pullRoute.kind === 'promo'
                                  ? held.promo
                                  : held.bank
                              );
                            })()}
                            selected={on}
                            disabled={clubsBlocked}
                            title={
                              clubsBlocked
                                ? route.kind === 'refused'
                                  ? route.reason
                                  : undefined
                                : undefined
                            }
                            onSelect={() => {
                              setTarget({ type: 'club', data: c });
                              setNotice(null);
                            }}
                          />
                        );
                      })}
                      {filtered.roster.slice(0, 200).map((r) => {
                        const on = target?.type === 'member' && target.data.user_id === r.user_id;
                        return (
                          <WalletDeskRow
                            key={`${r.user_id}-${r.club_id}`}
                            name={titleCase(r.display_name || r.username || r.user_id.slice(0, 8))}
                            sub={titleCase(r.club_name || '')}
                            tag={enumToTitleCase(r.member_role || 'member')}
                            selected={on}
                            onSelect={() => {
                              setTarget({ type: 'member', data: r });
                              setNotice(null);
                            }}
                          />
                        );
                      })}
                    </>
                  )}
                </div>
                {clubsBlocked && filtered.clubs.length > 0 && route.kind === 'refused' && (
                  <div className="wdesk__empty">{route.reason}</div>
                )}
              </>
            )}

            {mode === 'ledger' && (
              <>
                <WalletDeskHeading
                  title="Ledger"
                  meta={`${ledgerTotal.toLocaleString('en-US')} Entries · ${walletLabel}`}
                />
                {ledgerError && <div className="wdesk__empty wdesk__empty--bad">{ledgerError}</div>}
                {!ledgerError && ledgerTotals && (
                  <div className="wdesk__words" aria-label="Ledger Totals">
                    <span className="wdesk__headingMeta">
                      Received <span className="wdesk__in">{money(ledgerTotals.in)}</span>
                    </span>
                    <span className="wdesk__headingMeta">
                      Sent Out <span className="wdesk__out">{money(ledgerTotals.out)}</span>
                    </span>
                    <span className="wdesk__headingMeta">
                      Net <span>{money(ledgerTotals.net)}</span>
                    </span>
                  </div>
                )}
                <div className="wdesk__list">
                  {!ledgerError &&
                    ledger.map((r) => {
                      const inbound = r.direction === 'in';
                      const other = r.counterparty_name || null;
                      return (
                        <WalletDeskRow
                          key={r.id}
                          /* The category is a Postgres enum, so it reaches the screen
                       through the house transform: the copy gates never see a
                       value that came out of a row. */
                          name={enumToTitleCase(r.category)}
                          sub={
                            <>
                              <span>
                                {other
                                  ? inbound
                                    ? `From ${titleCase(other)}`
                                    : `To ${titleCase(other)}`
                                  : walletLabel}
                              </span>
                              <span>{` · ${when(r.created_at)}`}</span>
                              {r.notes && <span>{` · ${titleCase(r.notes)}`}</span>}
                              {r.actor_name && <span>{` · By ${titleCase(r.actor_name)}`}</span>}
                              {r.balance_after != null && (
                                <span className="wdesk__sep">
                                  Wallet After {formatWalletChips(Number(r.balance_after))}
                                </span>
                              )}
                            </>
                          }
                          figure={
                            <span className={inbound ? 'wdesk__in' : 'wdesk__out'}>
                              {`${inbound ? '+' : '-'}${money(r.amount)}`}
                            </span>
                          }
                        />
                      );
                    })}
                  {!ledgerError && !ledgerLoading && ledger.length === 0 && (
                    <div className="wdesk__empty">
                      Nothing Has Moved Through This Wallet Yet. Every Send, Sweep And Settlement
                      Writes A Row Here.
                    </div>
                  )}
                  {ledgerLoading && <div className="wdesk__empty">Loading Ledger</div>}
                  {moreLedger && (
                    <button
                      type="button"
                      className="wdesk__more"
                      onClick={() => void loadLedger(ledger.length)}
                      disabled={ledgerLoading}
                      aria-label="Load More Ledger Entries"
                    >
                      Load More
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {!sheetOpen && notice && (
          <div
            role={notice.ok ? 'status' : 'alert'}
            className={notice.ok ? 'wdesk__empty' : 'wdesk__empty wdesk__empty--bad'}
          >
            {notice.text}
          </div>
        )}
      </WalletDesk>
    </div>,
    document.body
  );
}

export default UnionWalletModal;
