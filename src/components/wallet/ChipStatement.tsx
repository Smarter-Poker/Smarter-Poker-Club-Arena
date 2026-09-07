/**
 * CHIP STATEMENT - a player can audit their own chips (phase 7, roadmap 9.5).
 *
 * "A standard nobody outside the team can check is half a standard, and this
 *  is also the cheapest support tool on the platform: 'where did my chips go'
 *  answers itself. Same for a club operator and their treasury."
 *
 * One RPC, fn_ca_chip_statement, answers three things and this renders them:
 *
 *   1. THE BALANCE NOW, per club and in total (scope=player), or the club's
 *      treasury (scope=club_treasury).
 *   2. THE LEGS, both directions, newest first, from this account's point of
 *      view: what came in, what went out, from or to what. The surface this
 *      replaces on the wallet page asked chip_ledger only for legs where the
 *      player was `performed_by` or `to_entity_id`, so every chip that LEFT
 *      the player - buy-ins, entries, rebuys - was invisible.
 *   3. THE AUDIT. The platform reads every wallet against the journal nightly
 *      (fn_ca_ledger_replay -> ca_account_snapshots). This shows that reading
 *      and the arithmetic since it: balance at reading + in - out = expected,
 *      against the balance now. The three numbers are the same three the
 *      platform's own control uses; the player is not shown a friendlier
 *      version of the truth.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). The RPC binds scope=player to
 * auth.uid() and has no horse branch; this component has none either.
 *
 * Mobile first: one column at 375px, the audit line wraps, every tap target
 * is 44px.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import './ChipStatement.css';

export type StatementScope = 'player' | 'club_treasury';

export interface StatementLeg {
  id: string;
  at: string;
  direction: 'in' | 'out';
  amount: number;
  category: string;
  description: string | null;
  counterparty_type: string | null;
  counterparty_label: string | null;
  counterparty_id: string | null;
  club_id: string | null;
  table_id: string | null;
  tournament_id: string | null;
  hand_id: string | null;
  settlement_id: string | null;
}

export interface StatementAudit {
  status: 'reconciles' | 'does_not_reconcile' | 'no_reading_yet' | 'no_balance';
  detail?: string;
  read_at?: string;
  balance_at_reading?: number;
  reading_is_baseline?: boolean;
  cumulative_unexplained_at_reading?: number;
  in_since?: number;
  out_since?: number;
  legs_since?: number;
  expected_now?: number;
  balance_now?: number;
  unexplained?: number | null;
}

export interface Statement {
  scope: StatementScope;
  entity_id: string;
  account: string;
  club_filter: string | null;
  balance_now: number;
  balance_exists: boolean;
  clubs: { club_id: string; club_name: string; balance: number }[];
  legs: StatementLeg[];
  has_more: boolean;
  next_before: string | null;
  audit: StatementAudit;
  generated_at: string;
  ms: number;
}

/** The live journal vocabulary, in the player's words. Unknown categories are
 *  shown as they are, never hidden: a leg with a name nobody mapped is still a
 *  leg. */
const CATEGORY_LABEL: Record<string, string> = {
  buyin: 'Table Buy-In',
  addon: 'Add-On',
  rebuy: 'Rebuy',
  table_cashout: 'Table Cash-Out',
  settlement: 'Table Settlement',
  tournament_buyin: 'Tournament Entry',
  tournament_prize: 'Tournament Prize',
  bounty: 'Bounty',
  spin_entry: 'Spin Entry',
  spin_prize: 'Spin Prize',
  rake: 'Rake',
  rakeback: 'Rakeback',
  bbj_contribution: 'Jackpot Contribution',
  bbj_payout: 'Jackpot Payout',
  promo: 'Promo Chips',
  refund: 'Refund',
  overlay: 'Overlay',
  adjustment: 'Adjustment',
  correction: 'Correction',
  horse_funding: 'Table Funding',
  player_funding: 'Chips From The Club',
  transfer: 'Transfer',
  cashout: 'Cash-Out',
  deposit: 'Deposit',
  mint: 'Chips Issued',
};

const COUNTERPARTY_LABEL: Record<string, string> = {
  table_stack: 'A Table',
  prize_liability: 'A Prize Pool',
  player_wallet: 'A Player',
  club_treasury: 'The Club',
  union_wallet: 'The Union',
  union_bank: 'The Union Bank',
  bbj_pool: 'The Jackpot',
  spin_reserve: 'The Spin Reserve',
  promo_wallet: 'A Promo Wallet',
  agent_wallet: 'An Agent',
  settlement_suspense: 'Settlement',
  system_mint: 'The Mint',
  system_burn: 'The Mint',
};

export function categoryLabel(category: string): string {
  return (
    CATEGORY_LABEL[category] || category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function counterpartyLabel(leg: StatementLeg): string {
  const type = leg.counterparty_type || '';
  const base =
    COUNTERPARTY_LABEL[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return leg.counterparty_label ? `${base} (${leg.counterparty_label})` : base || 'Unknown';
}

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

interface Props {
  scope: StatementScope;
  /** Required for club_treasury; optional club filter for a player. */
  clubId?: string | null;
  pageSize?: number;
  title?: string;
}

export default function ChipStatement({ scope, clubId, pageSize = 50, title }: Props) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [legs, setLegs] = useState<StatementLeg[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      const { data, error: rpcError } = await supabase.rpc('fn_ca_chip_statement', {
        p_scope: scope,
        p_club_id: clubId || null,
        p_before: before,
        p_limit: pageSize,
      });
      if (rpcError) throw rpcError;
      return data as Statement;
    },
    [scope, clubId, pageSize]
  );

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDenied(false);
    try {
      const s = await load(null);
      setStatement(s);
      setLegs(s.legs || []);
    } catch (e) {
      if (isAuthzError(e)) {
        setDenied(true);
      } else {
        // A discarded error read as "no movements", which on a statement is
        // the one answer that must never be guessed.
        reportError(e, 'ChipStatement.load');
        setError('The Statement Could Not Be Loaded');
      }
    }
    setLoading(false);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!statement?.has_more || !statement.next_before || loadingMore) return;
    setLoadingMore(true);
    try {
      const s = await load(statement.next_before);
      setStatement((prev) =>
        prev ? { ...prev, has_more: s.has_more, next_before: s.next_before } : s
      );
      setLegs((prev) => [...prev, ...(s.legs || [])]);
    } catch (e) {
      reportError(e, 'ChipStatement.loadMore');
      setError('More Of The Statement Could Not Be Loaded');
    }
    setLoadingMore(false);
  }, [statement, load, loadingMore]);

  useEffect(() => {
    if (scope === 'club_treasury' && !clubId) {
      setLoading(false);
      setStatement(null);
      return;
    }
    loadFirst();
  }, [loadFirst, scope, clubId]);

  const audit = statement?.audit;
  const auditTone = useMemo(() => {
    if (!audit) return 'neutral';
    if (audit.status === 'reconciles') return 'good';
    if (audit.status === 'does_not_reconcile') return 'bad';
    return 'neutral';
  }, [audit]);

  const heading = title || (scope === 'player' ? 'Your Chip Statement' : 'Treasury Statement');

  if (loading) {
    return (
      <section className="chip-statement" aria-busy="true" aria-label={heading}>
        <div className="chip-statement__empty">Loading Your Statement...</div>
      </section>
    );
  }
  if (denied) {
    return (
      <section className="chip-statement" aria-label={heading}>
        <div className="chip-statement__empty">
          This Statement Is Available To Club Owners, Admins And Super Agents.
        </div>
      </section>
    );
  }
  if (error || !statement) {
    return (
      <section className="chip-statement" aria-label={heading}>
        <div className="chip-statement__empty" role="alert">
          <div>{error || 'The Statement Could Not Be Loaded'}</div>
          <button type="button" className="chip-statement__btn" onClick={() => loadFirst()}>
            Try Again
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="chip-statement" aria-label={heading} data-scope={scope}>
      <header className="chip-statement__header">
        <h3 className="chip-statement__title">{heading}</h3>
        <div className="chip-statement__balance">
          <span className="chip-statement__balance-label">Balance Now</span>
          <span className="chip-statement__balance-value">{chips(statement.balance_now)}</span>
        </div>
      </header>

      {scope === 'player' && statement.clubs.length > 1 && (
        <ul className="chip-statement__clubs" aria-label="Balance By Club">
          {statement.clubs.map((c) => (
            <li key={c.club_id} className="chip-statement__club">
              <span>{c.club_name}</span>
              <span>{chips(c.balance)}</span>
            </li>
          ))}
        </ul>
      )}

      {audit && (
        <div className={`chip-statement__audit chip-statement__audit--${auditTone}`} role="status">
          {audit.status === 'reconciles' && (
            <>
              <strong>Reconciles.</strong> Read At {when(audit.read_at || '')} As{' '}
              {chips(audit.balance_at_reading)}, Plus {chips(audit.in_since)} In, Minus{' '}
              {chips(audit.out_since)} Out ({audit.legs_since} Movements) Equals{' '}
              {chips(audit.expected_now)}, Which Is Your Balance.
            </>
          )}
          {audit.status === 'does_not_reconcile' && (
            <>
              <strong>Does Not Reconcile.</strong> Read At {when(audit.read_at || '')} As{' '}
              {chips(audit.balance_at_reading)}, Plus {chips(audit.in_since)} In, Minus{' '}
              {chips(audit.out_since)} Out Should Be {chips(audit.expected_now)}; The Balance Is{' '}
              {chips(audit.balance_now)}. Difference {chips(audit.unexplained)}. The Platform Makes
              This Same Comparison Every Night And Files It When It Fails.
            </>
          )}
          {audit.status === 'no_reading_yet' && (
            <>
              <strong>No Reading Yet.</strong> This Wallet Has Not Yet Been Read By The Nightly
              Ledger Check. The Movements Below Are Complete; The Comparison Arrives After The Next
              06:40 UTC Reading.
            </>
          )}
          {audit.status === 'no_balance' && (
            <>
              <strong>No Balance.</strong> There Is No Wallet Row To Compare The Journal Against.
            </>
          )}
        </div>
      )}

      {legs.length === 0 ? (
        <div className="chip-statement__empty">No Chip Movements Yet.</div>
      ) : (
        <ol className="chip-statement__legs" aria-label="Chip Movements">
          {legs.map((leg) => (
            <li
              key={leg.id}
              className={`chip-statement__leg chip-statement__leg--${leg.direction}`}
            >
              <div className="chip-statement__leg-main">
                <span className="chip-statement__leg-category">{categoryLabel(leg.category)}</span>
                <span
                  className={`chip-statement__leg-amount chip-statement__leg-amount--${leg.direction}`}
                >
                  {leg.direction === 'in' ? '+' : '-'}
                  {chips(leg.amount)}
                </span>
              </div>
              <div className="chip-statement__leg-meta">
                <span>
                  {leg.direction === 'in' ? 'From ' : 'To '}
                  {counterpartyLabel(leg)}
                </span>
                <time dateTime={leg.at}>{when(leg.at)}</time>
              </div>
            </li>
          ))}
        </ol>
      )}

      {statement.has_more && (
        <button
          type="button"
          className="chip-statement__btn chip-statement__more"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading...' : 'Load Earlier Movements'}
        </button>
      )}

      <footer className="chip-statement__footer">
        Generated {when(statement.generated_at)} From The Chip Journal. Every Line Is A Journal Leg;
        Nothing Is Summarised Away.
      </footer>
    </section>
  );
}
