/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT PORTAL PAGE — Agent Financial Command Center
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Owns the routed agent wallet, commission ledger, invoice and transaction
 *  experience. Transfers use a scoped dialog and live updates arrive by bus.
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { CreditService } from '../services/CreditService';
import { WalletService } from '../services/WalletService';
import { useIsMounted } from '../hooks/useIsMounted';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import AgentInvoicesPanel from '../components/agent/AgentInvoicesPanel';
import { reportError } from '../utils/errorReporter';
import { useUserStore } from '../stores/useUserStore';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { compactChips } from '../utils/format';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { titleCase } from '../utils/titleCase';
import styles from './AgentPortalPage.module.css';

interface AgentWallet {
  agentBal: number;
  playerBal: number;
  promoBal: number;
  creditLimit: number;
  debt: number;
  isPrepaid: boolean;
}

interface CommissionDay {
  name: string;
  commissions: number;
}

const EMPTY_WALLET: AgentWallet = {
  agentBal: 0,
  playerBal: 0,
  promoBal: 0,
  creditLimit: 0,
  debt: 0,
  isPrepaid: false,
};

function finiteMoney(value: unknown, label: string): number {
  if (value === null || value === undefined || value === '')
    throw new Error(`${label} Could Not Be Verified`);
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(`${label} Could Not Be Verified`);
  return amount;
}

function commissionRow(value: unknown): { amount: number; createdAt: Date } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Commission Entry Could Not Be Verified');
  }
  const row = value as Record<string, unknown>;
  const amount = finiteMoney(row.amount, 'Commission Amount');
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new Error('Commission Amount Could Not Be Verified');
  }
  if (typeof row.created_at !== 'string') {
    throw new Error('Commission Date Could Not Be Verified');
  }
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error('Commission Date Could Not Be Verified');
  }
  return { amount, createdAt };
}

export default function AgentPortalPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const currentClubId = useUserStore((state) => state.currentClubId);
  const [walletError, setWalletError] = useState<string | null>(null);
  const renderScope = JSON.stringify([user?.id, currentClubId]);
  const walletScope = useRef(renderScope);
  walletScope.current = renderScope;
  const walletRequest = useRef(0);
  const commissionRequest = useRef(0);
  const transferRequest = useRef(0);
  const walletIdentity = useRef<{ scope: string; clubId: string } | null>(null);
  const [loadedWalletScope, setLoadedWalletScope] = useState<string | null>(null);

  const [wallet, setWallet] = useState<AgentWallet>(EMPTY_WALLET);
  const [commissionData, setCommissionData] = useState<CommissionDay[]>([]);
  const [commissionError, setCommissionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferAmount, setTransferAmount] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const transferInFlight = useRef(false);
  const [visibleSections, setVisibleSections] = useState<Set<number>>(new Set());
  const [agentClubId, setAgentClubId] = useState<string | null>(null);
  const [agentPkId, setAgentPkId] = useState<string | null>(null); // agents.id PK (different from auth.uid)
  const isMounted = useIsMounted();
  const walletReady = loadedWalletScope === renderScope && !!agentClubId;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useVisibilityRefresh(() => loadData());

  useEffect(() => {
    walletRequest.current += 1;
    commissionRequest.current += 1;
    transferRequest.current += 1;
    setTransferModalOpen(false);
    setTransferAmount('');
    setWallet(EMPTY_WALLET);
    setWalletError(null);
    setCommissionData([]);
    setCommissionError(null);
    setLoadedWalletScope(null);
    setAgentClubId(null);
    setAgentPkId(null);
    walletIdentity.current = null;
    loadData();
    // Stagger animations — clean up timers on unmount
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        if (isMounted.current) setVisibleSections((prev) => new Set(prev).add(i));
      }, i * 80)
    );
    return () => timers.forEach(clearTimeout);
    // This effect intentionally restarts only when the signed-in wallet scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentClubId]);

  useEffect(() => {
    if (!transferModalOpen) return undefined;
    returnFocusRef.current = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !transferInFlight.current) {
        setTransferModalOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      const back = returnFocusRef.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [transferModalOpen]);

  // Bus listeners
  useEffect(() => {
    const unsub1 = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadWallet(), 1000);
    return () => {
      unsub1();
    };
    // The bus listener is rebound to the exact signed-in club scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentClubId]);

  // RT subscription: auto-refresh when agent wallet changes in Supabase
  useEffect(() => {
    if (!user?.id || !agentPkId) return;
    masterBus
      .getOrCreateChannel(`agent-portal-${user.id}-${agentPkId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `user_id=eq.${user.id}` },
        () => {
          if (isMounted.current) loadWallet();
        }
      )
      .on(
        'postgres_changes',
        {
          // SWEEP #3 (2026-07-23): commission_ledger never existed - the
          // per-hand commission ledger is agent_commissions, keyed by auth
          // user_id. That fixed the table NAME. It does not make this live:
          // agent_commissions left the publication in the 2026-09-06 trim
          // (1,802,610 writes, 6.7M live rows), as did `agents` above, so
          // neither of these two subscriptions delivers anything. The page is
          // covered by useVisibilityRefresh(loadData) instead, which re-runs
          // both loadWallet() and loadCommissionHistory().
          event: 'INSERT',
          schema: 'public',
          table: 'agent_commissions',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          if (isMounted.current) loadCommissionHistory();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'AgentPortalPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentPortalPage] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(`agent-portal-${user.id}-${agentPkId}`);
    };
    // Realtime identity is the signed-in user, selected club, and resolved agent record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentClubId, agentPkId]);

  const loadingRef = useRef<string | null>(null);

  const loadData = async () => {
    const scope = renderScope;
    if (!user?.id || !isMounted.current || scope !== walletScope.current) return;
    if (loadingRef.current === scope) return;
    loadingRef.current = scope;
    setLoading(true);
    try {
      // loadWallet FIRST — it resolves the agents.id PK needed by AgentInvoicesPanel
      await loadWallet();
      await loadCommissionHistory();
    } finally {
      if (loadingRef.current === scope) loadingRef.current = null;
      if (isMounted.current && walletScope.current === scope) setLoading(false);
    }
  };

  const loadWallet = async (): Promise<string | null> => {
    const scope = renderScope;
    if (!user?.id || !isMounted.current || scope !== walletScope.current) return null;
    const request = ++walletRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === walletScope.current && request === walletRequest.current;
    setAgentClubId(null);
    setLoadedWalletScope(null);
    setWallet(EMPTY_WALLET);
    setWalletError(null);
    walletIdentity.current = null;
    try {
      if (!currentClubId) throw new Error('Choose A Club Before Using Your Wallet');
      const resolvedClub = await resolveClubUUID(currentClubId);
      if (!resolvedClub) throw new Error('Choose A Valid Club Before Using Your Wallet');
      const query = supabase
        .from('agents')
        .select('id, club_id, agent_wallet_balance, promo_wallet_balance, credit_limit')
        // user.id is auth.users.id, NOT agents.id (PK) — query by user_id
        .eq('user_id', user.id)
        .eq('club_id', resolvedClub);
      const { data, error } = await query.maybeSingle();

      if (error || !data) throw new Error('Open Your Club Before Using The Agent Wallet');
      const { data: member, error: memberError } = await supabase
        .from('club_members')
        .select('chip_balance')
        .eq('club_id', data.club_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (memberError || !member) throw memberError || new Error('Player Wallet Not Found');

      // Use the resolved agents.id PK — CreditService uses .eq('id', agentId) internally.
      // Debt is part of the reading. If it cannot be read, zero would be a
      // false all-clear, so the entire wallet remains unavailable.
      const calculatedDebt = await CreditService.calculateDebt(data.id);
      if (typeof calculatedDebt.isPrepaid !== 'boolean') {
        throw new Error('Credit Type Could Not Be Verified');
      }
      const nextWallet = {
        agentBal: finiteMoney(data.agent_wallet_balance, 'Business Wallet'),
        playerBal: finiteMoney(member.chip_balance, 'Play Wallet'),
        promoBal: finiteMoney(data.promo_wallet_balance, 'Promo Wallet'),
        creditLimit: finiteMoney(calculatedDebt.creditLimit, 'Credit Limit'),
        debt: finiteMoney(calculatedDebt.debtOwed, 'Debt'),
        isPrepaid: calculatedDebt.isPrepaid,
      };

      if (!isCurrent()) return null;
      setWalletError(null);
      walletIdentity.current = { scope, clubId: data.club_id };
      setLoadedWalletScope(scope);
      setAgentPkId(data.id); // Triggers RT subscription re-creation with correct filter
      if (data.club_id) setAgentClubId(data.club_id);
      setWallet(nextWallet);
      return data.id;
    } catch (err) {
      if (isCurrent()) {
        setWallet(EMPTY_WALLET);
        setWalletError(
          safeErrorMessage(err, 'The Agent Wallet Could Not Be Verified. Nothing Has Been Changed.')
        );
        setAgentClubId(null);
        setAgentPkId(null);
        setLoadedWalletScope(scope);
        walletIdentity.current = null;
        setCommissionData([]);
        setCommissionError(null);
      }
      reportError(err, 'AgentPortalPage.loadWallet_error');
      return null;
    }
  };

  const loadCommissionHistory = async () => {
    // SWEEP #3 (2026-07-23): repointed off the phantom commission_ledger table.
    // agent_commissions is keyed by auth user_id (not agents.id PK), so no PK
    // resolution is needed here; `amount` is the per-hand commission earned.
    const scope = renderScope;
    const identity = walletIdentity.current;
    if (
      !user?.id ||
      !isMounted.current ||
      scope !== walletScope.current ||
      identity?.scope !== scope
    )
      return;
    const request = ++commissionRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === walletScope.current && request === commissionRequest.current;
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 86400000);
    try {
      const { data, error } = await supabase
        .from('agent_commissions')
        .select('amount, created_at')
        .eq('user_id', user.id)
        .eq('club_id', identity.clubId)
        .gte('created_at', windowStart.toISOString())
        .lte('created_at', windowEnd.toISOString())
        .order('created_at', { ascending: true })
        .limit(5000);
      if (!isCurrent()) return;
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Commission History Was Not Returned');

      if (data.length > 0) {
        const grouped: Record<string, number> = {};
        data.forEach((entry) => {
          const { amount, createdAt } = commissionRow(entry);
          if (createdAt < windowStart || createdAt > windowEnd) {
            throw new Error('Commission Date Was Outside The Requested Window');
          }
          const day = createdAt.toLocaleDateString('en-US', { weekday: 'short' });
          grouped[day] = (grouped[day] || 0) + amount;
        });
        setCommissionData(days.map((day) => ({ name: day, commissions: grouped[day] || 0 })));
      } else {
        setCommissionData(days.map((day) => ({ name: day, commissions: 0 })));
      }
      setCommissionError(null);
    } catch (err) {
      reportError(err, 'AgentPortalPage.Commission_history_error');
      if (isCurrent()) {
        setCommissionData([]);
        setCommissionError(
          safeErrorMessage(
            err,
            'Commission History Could Not Be Read. No Zero Total Is Being Shown.'
          )
        );
      }
    }
  };

  const handleTransfer = async () => {
    const scope = renderScope;
    const viewerId = user?.id;
    const clubId = agentClubId;
    const amount = parseFloat(transferAmount);
    if (transferInFlight.current) return;
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !viewerId ||
      !clubId ||
      !walletReady ||
      scope !== walletScope.current ||
      walletIdentity.current?.scope !== scope ||
      walletIdentity.current.clubId !== clubId
    ) {
      if (isMounted.current) toast.error('Enter a valid amount');
      return;
    }
    const request = ++transferRequest.current;
    const isCurrent = () =>
      isMounted.current &&
      request === transferRequest.current &&
      scope === walletScope.current &&
      viewerId === user?.id &&
      walletIdentity.current?.scope === scope &&
      walletIdentity.current.clubId === clubId;
    // A committed request may already have reduced this display. The RPC must
    // decide insufficiency after replay lookup, so the same intent can recover.
    transferInFlight.current = true;
    setIsTransferring(true);
    try {
      const success = await WalletService.agentSelfTransfer(clubId, amount);
      if (!isCurrent()) return;
      if (success) {
        if (isMounted.current)
          toast.success(`Transferred ${compactChips(amount)} Chips To Play Wallet`);
        setTransferModalOpen(false);
        setTransferAmount('');
        await loadWallet();
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_transfer', userId: viewerId });
      } else {
        if (isMounted.current) toast.error('Transfer failed');
      }
    } catch (err) {
      reportError(err, 'AgentPortalPage.transfer_failed');
      if (isCurrent()) toast.error('Transfer Failed: ' + safeErrorMessage(err, 'Try Again'));
    } finally {
      transferInFlight.current = false;
      if (isMounted.current) setIsTransferring(false);
    }
  };

  if (loading) {
    return (
      <main className={styles.page}>
        <h1 className={styles.srOnly}>Agent Command Center</h1>
        <SpadeConsole
          family="riveted"
          crest="spade"
          eyebrow="Club Arena Data"
          title="Agent Command Center"
          pill="Reading"
          pillInk="gold"
          plates={{
            secondary: { label: 'Back', onClick: () => navigate(-1) },
            primary: { label: 'Reading', disabled: true },
          }}
        >
          <p className="sc-copy sc-copy--center" role="status">
            Reading The Selected Club Wallets And Commissions
          </p>
        </SpadeConsole>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.srOnly}>Agent Command Center</h1>
      <SpadeConsole
        family="riveted"
        crest="spade"
        eyebrow="Club Arena Data"
        title="Agent Command Center"
        subtitle="Wallets, Credit And Commission Control"
        pill={walletError ? 'Unavailable' : walletReady ? 'Scoped' : 'Closed'}
        pillInk={walletError ? 'red' : walletReady ? 'blue' : 'gold'}
        className={styles.section}
        plates={{
          secondary: { label: 'Back', onClick: () => navigate(-1) },
          primary: walletError
            ? { label: 'Open Clubs', onClick: () => navigate('/clubs') }
            : {
                label: 'Transfer To Play',
                onClick: () => setTransferModalOpen(true),
                disabled: !walletReady || isTransferring,
              },
        }}
      >
        {walletError ? (
          <p className="sc-copy sc-copy--center sc-ink--red" role="alert">
            {titleCase(walletError)}
          </p>
        ) : (
          <>
            <section
              className={styles.walletRows}
              aria-label="Agent Wallets"
              data-visible={visibleSections.has(1)}
            >
              <div className={styles.moneyRow}>
                <span>
                  <strong>Business Wallet</strong>
                  <small>Commissions And Settlements</small>
                </span>
                <b className="sc-ink--silver">{compactChips(wallet.agentBal)}</b>
              </div>
              <div className={styles.moneyRow}>
                <span>
                  <strong>Play Wallet</strong>
                  <small>Selected Club Balance</small>
                </span>
                <b className="sc-ink--blue">{compactChips(wallet.playerBal)}</b>
              </div>
              <div className={styles.moneyRow}>
                <span>
                  <strong>Promo Wallet</strong>
                  <small>Non-Cashable Giveaways</small>
                </span>
                <b className="sc-ink--gold">{compactChips(wallet.promoBal)}</b>
              </div>
            </section>

            <section
              className={styles.creditRows}
              aria-label="Credit Line"
              data-visible={visibleSections.has(2)}
            >
              <h2 className={styles.glassHeading}>Credit Line</h2>
              <div className={styles.moneyRow}>
                <span>Limit</span>
                <b className="sc-ink--silver">
                  {wallet.isPrepaid ? 'Prepaid' : compactChips(wallet.creditLimit)}
                </b>
              </div>
              <div className={styles.moneyRow}>
                <span>Used</span>
                <b className="sc-ink--red">{compactChips(wallet.isPrepaid ? 0 : wallet.debt)}</b>
              </div>
              <div className={styles.moneyRow}>
                <span>Available</span>
                <b className="sc-ink--green">
                  {wallet.isPrepaid
                    ? 'Not Applicable'
                    : compactChips(Math.max(0, wallet.creditLimit - wallet.debt))}
                </b>
              </div>
              {!wallet.isPrepaid && wallet.debt > 0 && (
                <div className={styles.debtRow} role="status">
                  <span>
                    <strong className="sc-ink--red">Drawn Credit</strong>
                    <small>
                      {compactChips(wallet.debt)} Chips Currently Used. Payable Invoices Appear
                      Below.
                    </small>
                  </span>
                </div>
              )}
            </section>
          </>
        )}
      </SpadeConsole>

      <section className={styles.childSection} aria-label="Agent Invoices">
        <AgentInvoicesPanel agentId={agentPkId} />
      </section>

      <SpadeConsole
        family="spade"
        crest="flat"
        eyebrow="Seven Day Window"
        title="Commission Ledger"
        pill={commissionError ? 'Error' : 'Live'}
        pillInk={commissionError ? 'red' : 'blue'}
        foot="foot"
        className={styles.section}
      >
        {!walletReady ? (
          <p className="sc-copy sc-copy--center" role="status">
            Commission History Is Unavailable Until The Wallet Scope Is Verified
          </p>
        ) : commissionError ? (
          <div className={styles.statusBlock} role="alert">
            <p className="sc-copy sc-copy--center">{titleCase(commissionError)}</p>
            <button type="button" className={styles.litAction} onClick={loadCommissionHistory}>
              Retry Commission Reading
            </button>
          </div>
        ) : (
          <div className={styles.commissionRows} data-visible={visibleSections.has(3)}>
            {commissionData.map((day) => (
              <div className={styles.moneyRow} key={day.name}>
                <span>{day.name}</span>
                <b className="sc-ink--silver">{compactChips(day.commissions)} Chips</b>
              </div>
            ))}
            <div className={styles.totalRow}>
              Total: {compactChips(commissionData.reduce((sum, day) => sum + day.commissions, 0))}{' '}
              Chips
            </div>
          </div>
        )}
      </SpadeConsole>

      <section className={styles.childSection} aria-label="My Transactions">
        <TransactionLedgerView userId={user?.id} clubId={agentClubId || undefined} limit={15} />
      </section>

      {transferModalOpen &&
        createPortal(
          <div
            className={styles.modalBackdrop}
            role="presentation"
            onClick={() => {
              if (!transferInFlight.current) setTransferModalOpen(false);
            }}
          >
            <div
              ref={dialogRef}
              className={styles.modalDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="agent-transfer-title"
              aria-describedby="agent-transfer-description"
              aria-busy={isTransferring || undefined}
              onClick={(event) => event.stopPropagation()}
            >
              <SpadeConsole
                family="spade"
                crest="flat"
                as="div"
                onClose={isTransferring ? undefined : () => setTransferModalOpen(false)}
                eyebrow="Selected Club"
                title="Transfer To Play Wallet"
                titleId="agent-transfer-title"
                pill={isTransferring ? 'Working' : 'Ready'}
                pillInk={isTransferring ? 'gold' : 'blue'}
                plates={{
                  secondary: {
                    label: 'Cancel',
                    buttonRef: cancelRef,
                    onClick: () => setTransferModalOpen(false),
                    disabled: isTransferring,
                  },
                  primary: {
                    label: isTransferring ? 'Transferring' : 'Transfer',
                    onClick: handleTransfer,
                    disabled: isTransferring || !transferAmount || !walletReady,
                  },
                }}
              >
                <p id="agent-transfer-description" className="sc-copy sc-copy--center">
                  Available: {compactChips(wallet.agentBal)} Chips
                </p>
                <label className={styles.amountLabel} htmlFor="agent-transfer-amount">
                  Amount
                </label>
                <input
                  id="agent-transfer-amount"
                  className={styles.amountInput}
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Amount"
                  value={transferAmount}
                  onChange={(event) => setTransferAmount(event.target.value)}
                />
              </SpadeConsole>
            </div>
          </div>,
          document.body
        )}
    </main>
  );
}
