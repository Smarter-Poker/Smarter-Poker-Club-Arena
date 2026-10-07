import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import {
  parseClubFinancialsPayload,
  type FinancialDay,
  type FinancialTable,
  type RecentRake,
} from '../../utils/clubFinancialsPayload';
import { downloadCsv, toCsv } from '../../utils/downloadCsv';
import { compactChips, pct } from '../../utils/format';
import { reportError } from '../../utils/errorReporter';
import { resolveClubUUIDStrict } from '../../utils/strictClubIdResolver';
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
import { useToast } from '../common/Toast';
import './RakeReports.css';

type Period = 'today' | 'week' | 'month' | 'year';

interface DailyBreakdown {
  date: string;
  rake: number;
  hands: number;
}

interface RakeData {
  periodLabel: string;
  rangeStart: string;
  rangeEnd: string;
  seriesStart: string;
  trendStart: string;
  totalRake: number;
  totalHands: number;
  avgRakePerHand: number;
  topGames: FinancialTable[];
  dailyBreakdown: DailyBreakdown[];
  rawRecords: FinancialDay[];
  recentHands: Array<RecentRake & { hand_id: string }>;
}

interface RakeReportState {
  scope: string;
  status: 'loading' | 'ready' | 'denied' | 'error';
  message: string | null;
  data: RakeData | null;
}

interface RakeReportsProps {
  clubId: string;
  initialSnapshot?: {
    resolvedClubId: string;
    requestedStart: string;
    requestedEnd: string;
    financials: ReturnType<typeof parseClubFinancialsPayload>;
  };
}

interface HandPlayerBreakdown {
  player_id: string;
  gross_contribution: number | null;
  returned_uncalled: number | null;
  eligible_contribution: number | null;
  contribution_weight: number | null;
  weighted_rake_credit: number | null;
  bbj_attributed_contribution: number | null;
}

interface VerifiedHandBreakdown {
  found: true;
  hand_id: string;
  rake_method: 'WEIGHTED_CONTRIBUTED' | 'DEALT_EQUAL';
  gross_pot: number | null;
  regular_rake_collected: number;
  bbj_drop_collected: number | null;
  net_pot_paid_to_players: number | null;
  total_eligible_contributions: number;
  players: HandPlayerBreakdown[];
  reconciliation: {
    expected_regular_rake: number;
    allocated_regular_rake: number;
    difference: number;
    valid: boolean;
  };
}

interface MissingHandBreakdown {
  found: false;
  denied: boolean;
}

type ParsedHandBreakdown = VerifiedHandBreakdown | MissingHandBreakdown;
type LookupState = 'idle' | 'not-found' | 'denied' | 'error';

type JsonRecord = Record<string, unknown>;

const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidBreakdown(label: string): never {
  throw new Error(`Hand Rake Breakdown ${label} Is Invalid`);
}

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidBreakdown(label);
  return value as JsonRecord;
}

function uuidValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_TOKEN.test(value)) invalidBreakdown(label);
  return value.toLowerCase();
}

function moneyValue(
  value: unknown,
  label: string,
  options: { nullable?: boolean; signed?: boolean } = {}
): number | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidBreakdown(label);
  if (!options.signed && value < 0) invalidBreakdown(label);
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
    invalidBreakdown(label);
  }
  return cents / 100;
}

function moneyCents(value: number): number {
  return Math.round(value * 100);
}

function weightValue(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalidBreakdown(label);
  }
  return value;
}

function expectedWeightedCredits(
  amount: number,
  players: Array<{ player_id: string; eligible_contribution: number }>
): Map<string, number> {
  const amountCents = BigInt(moneyCents(amount));
  const totalCents = players.reduce(
    (sum, player) => sum + BigInt(moneyCents(player.eligible_contribution)),
    0n
  );
  if (totalCents <= 0n) invalidBreakdown('Weighted Allocation Basis');

  const allocations = players.map((player) => {
    const numerator = amountCents * BigInt(moneyCents(player.eligible_contribution));
    return {
      playerId: player.player_id,
      cents: numerator / totalCents,
      remainder: numerator % totalCents,
    };
  });
  const floorTotal = allocations.reduce((sum, allocation) => sum + allocation.cents, 0n);
  const remainderCount = Number(amountCents - floorTotal);
  if (
    !Number.isSafeInteger(remainderCount) ||
    remainderCount < 0 ||
    remainderCount > players.length
  ) {
    invalidBreakdown('Weighted Allocation Remainder');
  }
  allocations
    .slice()
    .sort((left, right) => {
      if (left.remainder !== right.remainder) {
        return left.remainder > right.remainder ? -1 : 1;
      }
      return left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0;
    })
    .slice(0, remainderCount)
    .forEach((allocation) => {
      allocation.cents += 1n;
    });
  return new Map(allocations.map((allocation) => [allocation.playerId, Number(allocation.cents)]));
}

/** Strictly validates the receipt returned by fn_hand_rake_breakdown. */
export function parseHandBreakdownPayload(
  value: unknown,
  expectedHandId: string
): ParsedHandBreakdown {
  const expected = uuidValue(expectedHandId, 'Expected Hand Identity');
  const record = objectValue(value, 'Receipt');
  if (record.found === false) {
    if (record.error !== undefined && record.error !== 'not_authorised') {
      invalidBreakdown('Refusal');
    }
    return { found: false, denied: record.error === 'not_authorised' };
  }
  if (record.found !== true) invalidBreakdown('Found State');

  const handId = uuidValue(record.hand_id, 'Hand Identity');
  if (handId !== expected) invalidBreakdown('Hand Binding');
  if (record.rake_method !== 'WEIGHTED_CONTRIBUTED' && record.rake_method !== 'DEALT_EQUAL') {
    invalidBreakdown('Rake Method');
  }
  if (!Array.isArray(record.players) || record.players.length > 12) {
    invalidBreakdown('Player Rows');
  }

  const seenPlayers = new Set<string>();
  const players = record.players.map((entry): HandPlayerBreakdown => {
    const player = objectValue(entry, 'Player Row');
    const playerId = uuidValue(player.player_id, 'Player Identity');
    if (seenPlayers.has(playerId)) invalidBreakdown('Duplicate Player Identity');
    seenPlayers.add(playerId);
    return {
      player_id: playerId,
      gross_contribution: moneyValue(player.gross_contribution, 'Gross Contribution', {
        nullable: true,
      }),
      returned_uncalled: moneyValue(player.returned_uncalled, 'Returned Uncalled', {
        nullable: true,
      }),
      eligible_contribution: moneyValue(player.eligible_contribution, 'Eligible Contribution', {
        nullable: true,
      }),
      contribution_weight: weightValue(player.contribution_weight, 'Contribution Weight'),
      weighted_rake_credit: moneyValue(player.weighted_rake_credit, 'Weighted Rake Credit', {
        nullable: true,
      }),
      bbj_attributed_contribution: moneyValue(
        player.bbj_attributed_contribution,
        'Bad Beat Attributed Contribution',
        { nullable: true }
      ),
    };
  });

  const regularRake = moneyValue(record.regular_rake_collected, 'Regular Rake');
  const reconciliationValue = objectValue(record.reconciliation, 'Reconciliation');
  const expectedRake = moneyValue(
    reconciliationValue.expected_regular_rake,
    'Expected Regular Rake'
  );
  const allocatedRake = moneyValue(
    reconciliationValue.allocated_regular_rake,
    'Allocated Regular Rake'
  );
  const difference = moneyValue(reconciliationValue.difference, 'Reconciliation Difference', {
    signed: true,
  });
  if (typeof reconciliationValue.valid !== 'boolean') invalidBreakdown('Reconciliation State');
  if (
    regularRake === null ||
    expectedRake === null ||
    allocatedRake === null ||
    difference === null
  ) {
    invalidBreakdown('Required Money');
  }
  if (
    moneyCents(expectedRake) !== moneyCents(regularRake) ||
    moneyCents(expectedRake) - moneyCents(allocatedRake) !== moneyCents(difference) ||
    reconciliationValue.valid !== (moneyCents(difference) === 0)
  ) {
    invalidBreakdown('Reconciliation Arithmetic');
  }
  const credits = players.map((player) => player.weighted_rake_credit);
  if (
    credits.every((credit): credit is number => credit !== null) &&
    credits.reduce((sum, credit) => sum + moneyCents(credit), 0) !== moneyCents(allocatedRake)
  ) {
    invalidBreakdown('Player Allocation');
  }

  const totalEligible = moneyValue(
    record.total_eligible_contributions,
    'Total Eligible Contributions'
  );
  if (totalEligible === null) invalidBreakdown('Total Eligible Contributions');
  players.forEach((player) => {
    if (player.returned_uncalled === null || player.bbj_attributed_contribution === null) {
      invalidBreakdown('Player Ledger Completeness');
    }
    const coreFields = [
      player.gross_contribution,
      player.eligible_contribution,
      player.contribution_weight,
      player.weighted_rake_credit,
    ];
    const coreFieldsPresent = coreFields.filter((field) => field !== null).length;
    if (coreFieldsPresent !== 0 && coreFieldsPresent !== coreFields.length) {
      invalidBreakdown('Player Ledger Completeness');
    }
    if (player.eligible_contribution !== null && moneyCents(player.eligible_contribution) <= 0) {
      invalidBreakdown('Eligible Contribution');
    }
    if (
      player.gross_contribution !== null &&
      player.returned_uncalled !== null &&
      player.eligible_contribution !== null &&
      moneyCents(player.gross_contribution) - moneyCents(player.returned_uncalled) !==
        moneyCents(player.eligible_contribution)
    ) {
      invalidBreakdown('Player Contribution Arithmetic');
    }
  });
  const completeEligibleRows = players.every(
    (player): player is HandPlayerBreakdown & { eligible_contribution: number } =>
      player.eligible_contribution !== null
  );
  if (
    players.length > 0 &&
    completeEligibleRows &&
    players.reduce((sum, player) => sum + moneyCents(player.eligible_contribution), 0) !==
      moneyCents(totalEligible)
  ) {
    invalidBreakdown('Eligible Contribution Total');
  }
  if (players.length > 0 && completeEligibleRows && moneyCents(totalEligible) > 0) {
    players.forEach((player) => {
      if (player.contribution_weight === null) return;
      const expectedWeight =
        Math.round(
          (moneyCents(player.eligible_contribution) / moneyCents(totalEligible)) * 100_000_000
        ) / 100_000_000;
      if (Math.abs(player.contribution_weight - expectedWeight) > 0.000000001) {
        invalidBreakdown('Contribution Weight');
      }
    });

    const completeWeightedRows = players.every(
      (
        player
      ): player is HandPlayerBreakdown & {
        eligible_contribution: number;
        weighted_rake_credit: number;
      } => player.weighted_rake_credit !== null
    );
    if (record.rake_method === 'WEIGHTED_CONTRIBUTED' && completeWeightedRows) {
      const weightedRows = players.map((player) => ({
        ...player,
        eligible_contribution: player.eligible_contribution as number,
        weighted_rake_credit: player.weighted_rake_credit as number,
      }));
      const expectedRegularCredits = expectedWeightedCredits(regularRake, weightedRows);
      weightedRows.forEach((player) => {
        if (
          expectedRegularCredits.get(player.player_id) !== moneyCents(player.weighted_rake_credit)
        ) {
          invalidBreakdown('Weighted Rake Credit');
        }
      });
    }
  }
  const grossPot = moneyValue(record.gross_pot, 'Gross Pot', { nullable: true });
  const badBeatDrop = moneyValue(record.bbj_drop_collected, 'Bad Beat Drop', {
    nullable: true,
  });
  const netPot = moneyValue(record.net_pot_paid_to_players, 'Net Pot', { nullable: true });
  if (
    (grossPot === null && netPot !== null) ||
    (grossPot !== null &&
      (netPot === null ||
        moneyCents(netPot) !==
          moneyCents(grossPot) - moneyCents(regularRake) - moneyCents(badBeatDrop ?? 0)))
  ) {
    invalidBreakdown('Pot Arithmetic');
  }
  return {
    found: true,
    hand_id: handId,
    rake_method: record.rake_method,
    gross_pot: grossPot,
    regular_rake_collected: regularRake,
    bbj_drop_collected: badBeatDrop,
    net_pot_paid_to_players: netPot,
    total_eligible_contributions: totalEligible,
    players,
    reconciliation: {
      expected_regular_rake: expectedRake,
      allocated_regular_rake: allocatedRake,
      difference,
      valid: reconciliationValue.valid,
    },
  };
}

function reportWindow(period: Period): { start: string; end: string } {
  const endDate = new Date();
  const end = endDate.toISOString().slice(0, 10);
  const startDate = new Date(endDate);
  if (period === 'week') startDate.setUTCDate(startDate.getUTCDate() - 6);
  if (period === 'month') startDate.setUTCDate(startDate.getUTCDate() - 29);
  if (period === 'year') startDate.setUTCDate(startDate.getUTCDate() - 364);
  return { start: period === 'today' ? end : startDate.toISOString().slice(0, 10), end };
}

function periodLabel(period: Period): string {
  if (period === 'today') return 'Today';
  if (period === 'week') return 'Seven Days';
  if (period === 'month') return 'Thirty Days';
  return 'One Year';
}

function dayLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function rangeLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function recentHandTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function chipLabel(value: number | null): string {
  if (value === null) return 'Unavailable';
  if (value > 0 && value < 1) return 'Under 1 Chip';
  return compactChips(value);
}

function weightLabel(value: number | null): string {
  if (value === null) return 'Unavailable';
  if (value > 0 && value < 0.01) return 'Under 1%';
  return pct(value);
}

function lookupMessage(state: LookupState): string | null {
  if (state === 'not-found') return 'No Raked Hand Was Found In This Club For That Entry.';
  if (state === 'denied') return 'This Hand Breakdown Is Restricted.';
  if (state === 'error') return 'The Hand Breakdown Could Not Be Verified.';
  return null;
}

export const RakeReports = ({ clubId, initialSnapshot }: RakeReportsProps) => {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [period, setPeriod] = useState<Period>('week');
  const scope = `${clubId}:${period}`;
  const currentScopeRef = useRef(scope);
  const reportRequestRef = useRef(0);
  const lookupRequestRef = useRef(0);
  const lookupInFlightRef = useRef<number | null>(null);
  currentScopeRef.current = scope;

  const [state, setState] = useState<RakeReportState>({
    scope,
    status: 'loading',
    message: null,
    data: null,
  });
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupState, setLookupState] = useState<LookupState>('idle');
  const [breakdown, setBreakdown] = useState<VerifiedHandBreakdown | null>(null);
  const [selectedHandId, setSelectedHandId] = useState<string | null>(null);

  const loadRakeData = useCallback(
    async (forceFresh = false) => {
      const requestScope = scope;
      const requestId = ++reportRequestRef.current;
      const isCurrent = () =>
        isMounted.current &&
        currentScopeRef.current === requestScope &&
        reportRequestRef.current === requestId;
      lookupRequestRef.current += 1;
      lookupInFlightRef.current = null;
      setLookupBusy(false);
      setLookupState('idle');
      setBreakdown(null);
      setSelectedHandId(null);
      setState({ scope: requestScope, status: 'loading', message: null, data: null });
      try {
        const range = reportWindow(period);
        const snapshot = initialSnapshot;
        const canReuseSnapshot =
          !forceFresh &&
          snapshot !== undefined &&
          UUID_TOKEN.test(snapshot.resolvedClubId) &&
          snapshot.requestedStart === range.start &&
          snapshot.requestedEnd === range.end &&
          snapshot.financials.range.end === range.end &&
          snapshot.financials.range.start >= range.start;
        let financials: ReturnType<typeof parseClubFinancialsPayload>;
        if (canReuseSnapshot && snapshot) {
          // Already verified by the parent for this exact club and window; the
          // parsed payload is not the wire receipt and cannot be parsed again.
          financials = snapshot.financials;
        } else {
          const resolvedId = await resolveClubUUIDStrict(clubId);
          const { data: payload, error } = await supabase.rpc('ca_club_financials', {
            p_club_id: resolvedId,
            p_start: range.start,
            p_end: range.end,
          });
          if (error) {
            if (isAuthzError(error)) {
              if (isCurrent()) {
                setState({ scope: requestScope, status: 'denied', message: null, data: null });
              }
              return;
            }
            throw error;
          }
          financials = parseClubFinancialsPayload(payload, { clubId: resolvedId, ...range });
        }
        const visibleDaily = financials.daily.slice(-7);
        const dailyBreakdown = visibleDaily.map((day) => ({
          date: dayLabel(day.d),
          rake: day.gross_rake,
          hands: day.raked_hands,
        }));
        const nextData: RakeData = {
          periodLabel: periodLabel(period),
          rangeStart: financials.range.start,
          rangeEnd: financials.range.end,
          seriesStart: financials.range.series_from,
          trendStart: visibleDaily[0]?.d ?? financials.range.series_from,
          totalRake: financials.totals.gross_rake,
          totalHands: financials.totals.raked_hands,
          avgRakePerHand:
            financials.totals.raked_hands > 0
              ? financials.totals.gross_rake / financials.totals.raked_hands
              : 0,
          topGames: financials.by_table,
          dailyBreakdown,
          rawRecords: financials.daily,
          recentHands: financials.recent.filter(
            (row): row is RecentRake & { hand_id: string } => row.hand_id !== null
          ),
        };
        if (!isCurrent()) return;
        setState({ scope: requestScope, status: 'ready', message: null, data: nextData });
      } catch (error) {
        const notFound = (error as { name?: string } | null)?.name === 'ClubNotFoundError';
        reportError(error, 'RakeReports.read');
        if (isCurrent()) {
          setState({
            scope: requestScope,
            status: 'error',
            message: notFound
              ? 'That Club Could Not Be Found.'
              : 'The Rake Report Could Not Be Verified. No Zero Report Is Being Shown.',
            data: null,
          });
        }
      }
    },
    [clubId, initialSnapshot, isMounted, period, scope]
  );

  useEffect(() => {
    void loadRakeData(false);
  }, [loadRakeData]);

  useEffect(() => {
    lookupRequestRef.current += 1;
    lookupInFlightRef.current = null;
    setLookupBusy(false);
    setLookupState('idle');
    setBreakdown(null);
    setSelectedHandId(null);
  }, [scope]);

  const activeState: RakeReportState =
    state.scope === scope ? state : { scope, status: 'loading', message: null, data: null };
  const data = activeState.status === 'ready' ? activeState.data : null;

  const exportCSV = useCallback(() => {
    if (!data || data.rawRecords.length === 0) {
      toast.info('No Daily Rake Rows Are Available For This Window.');
      return;
    }
    const ok = downloadCsv(
      `club-rake-daily-${data.seriesStart}-to-${data.rangeEnd}.csv`,
      toCsv(
        ['Day', 'Raked Hands', 'Gross Rake', 'Bad Beat Drop', 'Pot Volume', 'Tournament Fees'],
        data.rawRecords.map((day) => [
          day.d,
          day.raked_hands,
          day.gross_rake,
          day.bbj_drop,
          day.pot_volume,
          day.tournament_fees,
        ])
      )
    );
    if (!ok) toast.error('This Browser Could Not Start The Download');
  }, [data, toast]);

  const lookupHand = useCallback(
    async (handId: string) => {
      if (lookupInFlightRef.current !== null) return;
      const requestId = ++lookupRequestRef.current;
      lookupInFlightRef.current = requestId;
      const requestScope = scope;
      const isCurrent = () =>
        isMounted.current &&
        currentScopeRef.current === requestScope &&
        lookupRequestRef.current === requestId;
      setLookupBusy(true);
      setLookupState('idle');
      setBreakdown(null);
      setSelectedHandId(handId);
      try {
        const verifiedHandId = uuidValue(handId, 'Selected Hand Identity');
        const { data: result, error } = await supabase.rpc('fn_hand_rake_breakdown', {
          p_hand_id: verifiedHandId,
        });
        if (error) {
          if (isAuthzError(error)) {
            if (isCurrent()) setLookupState('denied');
            return;
          }
          throw error;
        }
        const parsed = parseHandBreakdownPayload(result, verifiedHandId);
        if (!parsed.found) {
          if (isCurrent()) setLookupState(parsed.denied ? 'denied' : 'not-found');
          return;
        }
        if (!isCurrent()) return;
        setBreakdown(parsed);
      } catch (error) {
        reportError(error, 'RakeReports.handBreakdown');
        if (isCurrent()) setLookupState('error');
      } finally {
        if (lookupInFlightRef.current === requestId) {
          lookupInFlightRef.current = null;
        }
        if (isCurrent()) setLookupBusy(false);
      }
    },
    [isMounted, scope]
  );

  const clearLookup = () => {
    lookupRequestRef.current += 1;
    lookupInFlightRef.current = null;
    setLookupBusy(false);
    setLookupState('idle');
    setBreakdown(null);
    setSelectedHandId(null);
  };

  if (activeState.status === 'loading') {
    return (
      <div className="rr">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Arena Data"
          title="Rake Reports"
          pill="Reading"
          pillInk="gold"
          foot="foot"
          aria-busy
        >
          <p className="sc-copy sc-copy--center" role="status">
            Verifying The Selected Club Rake Ledger
          </p>
        </SpadeConsole>
      </div>
    );
  }

  if (activeState.status === 'denied') {
    return (
      <div className="rr">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Arena Data"
          title="Rake Reports"
          pill="Restricted"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="alert">
            Rake Reports Are Available To Authorized Club Financial Staff.
          </p>
        </SpadeConsole>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rr">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Arena Data"
          title="Rake Reports"
          pill="Unavailable"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="alert">
            {activeState.message}
          </p>
          <button type="button" className="rr__word-action" onClick={() => void loadRakeData(true)}>
            Try Again
          </button>
        </SpadeConsole>
      </div>
    );
  }

  // Math.max of an empty list is -Infinity, and every bar height became NaN%.
  const maxRake = Math.max(0, ...data.dailyBreakdown.map((day) => day.rake));
  const visibleLookupMessage = lookupMessage(lookupState);

  return (
    <div className="rr">
      <SpadeConsole
        family="riveted"
        crest="spade"
        eyebrow="Club Arena Data"
        title="Rake Reports"
        subtitle="Authoritative Club Rollup"
        pill={data.periodLabel}
        pillInk="blue"
        plates={{
          secondary: { label: 'Export Daily CSV', onClick: exportCSV },
          primary: { label: 'Refresh Report', onClick: () => void loadRakeData(true) },
        }}
      >
        <div className="rr__rail" role="tablist" aria-label="Rake Reporting Window">
          {(['today', 'week', 'month', 'year'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              className={`rr__rail-word ${period === option ? 'sc-ink--silver' : 'sc-ink--muted'}`}
              aria-selected={period === option}
              onClick={() => setPeriod(option)}
            >
              {periodLabel(option)}
            </button>
          ))}
        </div>
        <dl className="rr__facts" aria-label="Verified Rake Summary">
          <div className="rr__fact">
            <dt className="sc-label sc-ink--blue">Gross Rake</dt>
            <dd className="sc-ink--silver">{chipLabel(data.totalRake)}</dd>
          </div>
          <div className="rr__fact">
            <dt className="sc-label sc-ink--blue">Raked Hands</dt>
            <dd className="sc-ink--silver">{compactChips(data.totalHands)}</dd>
          </div>
          <div className="rr__fact">
            <dt className="sc-label sc-ink--blue">Average Rake Per Hand</dt>
            <dd className="sc-ink--silver">{chipLabel(data.avgRakePerHand)}</dd>
          </div>
        </dl>
        <p className="sc-copy sc-copy--center">
          Totals Cover {rangeLabel(data.rangeStart)} Through {rangeLabel(data.rangeEnd)}. The Trend
          Shows The Latest {data.dailyBreakdown.length}{' '}
          {data.dailyBreakdown.length === 1 ? 'Daily Point' : 'Daily Points'} From{' '}
          {rangeLabel(data.trendStart)} Through {rangeLabel(data.rangeEnd)}. The CSV Covers All{' '}
          {data.rawRecords.length} Returned Daily{' '}
          {data.rawRecords.length === 1 ? 'Point' : 'Points'} From {rangeLabel(data.seriesStart)}{' '}
          Through {rangeLabel(data.rangeEnd)}.
        </p>
      </SpadeConsole>

      <SpadeConsole
        family="spade"
        crest="spade"
        eyebrow="Verified Daily Series"
        title="Daily Rake Trend"
        pill={`${data.dailyBreakdown.length} ${data.dailyBreakdown.length === 1 ? 'Day' : 'Days'}`}
        pillInk={maxRake > 0 ? 'blue' : 'muted'}
        foot="foot"
      >
        {maxRake === 0 ? (
          <p className="sc-copy sc-copy--center">No Rake Was Recorded In This Daily Series.</p>
        ) : (
          <div className="rr__bars" aria-label="Daily Gross Rake">
            {data.dailyBreakdown.map((day) => (
              <div
                className="rr__bar-group"
                key={day.date}
                aria-label={`${day.date}, ${compactChips(day.rake)} Gross Rake, ${compactChips(day.hands)} Raked Hands`}
              >
                <div className="rr__bar-track" aria-hidden="true">
                  <span
                    className="rr__bar-fill"
                    style={{ '--rr-bar-height': `${(day.rake / maxRake) * 100}%` } as CSSProperties}
                  />
                </div>
                <span className="rr__bar-value sc-ink--silver">{chipLabel(day.rake)}</span>
                <span className="rr__bar-label sc-ink--muted">{day.date}</span>
              </div>
            ))}
          </div>
        )}
      </SpadeConsole>

      <SpadeConsole
        family="spade"
        crest="spade"
        eyebrow="Selected Club"
        title="Top Tables By Rake"
        pill={data.topGames.length === 0 ? 'Empty' : compactChips(data.topGames.length)}
        pillInk={data.topGames.length === 0 ? 'muted' : 'blue'}
        foot="foot"
      >
        {data.topGames.length === 0 ? (
          <p className="sc-copy sc-copy--center">No Table Rake Was Recorded In This Window.</p>
        ) : (
          <ol className="rr__list">
            {data.topGames.map((game, index) => (
              <li className="rr__row" key={game.table_id}>
                <span className="rr__rank sc-ink--gold">{index + 1}</span>
                <span className="rr__row-copy">
                  <strong className="sc-ink--silver">{titleCase(game.name)}</strong>
                  <small className="sc-ink--muted">
                    {[game.variant, game.stakes]
                      .filter((value): value is string => Boolean(value))
                      .map((value) => titleCase(value))
                      .join(' ')}
                  </small>
                </span>
                <span className="rr__row-value sc-ink--blue">
                  {chipLabel(game.rake)}
                  <small>{compactChips(game.raked_hands)} Hands</small>
                </span>
              </li>
            ))}
          </ol>
        )}
      </SpadeConsole>

      <SpadeConsole
        family="spade"
        crest="spade"
        eyebrow="Server Guarded"
        title="Hand Rake Breakdown"
        pill={
          lookupBusy
            ? 'Reading'
            : breakdown
              ? 'Verified'
              : data.recentHands.length === 0
                ? 'No Recent Hands'
                : 'Choose Hand'
        }
        pillInk={lookupBusy ? 'gold' : breakdown ? 'blue' : 'muted'}
        foot="foot"
      >
        {data.recentHands.length === 0 ? (
          <p className="sc-copy sc-copy--center">
            No Recent Raked Hands Are Available In This Returned Window.
          </p>
        ) : (
          <ol className="rr__recent-list" aria-label="Recent Raked Hands">
            {data.recentHands.map((hand) => {
              const handNumber =
                hand.global_hand_id === null
                  ? 'Recorded Hand'
                  : `Hand ${compactChips(hand.global_hand_id)}`;
              const label = `${titleCase(hand.table_name)}, ${handNumber}, ${recentHandTimeLabel(hand.created_at)}`;
              return (
                <li key={hand.id}>
                  <button
                    type="button"
                    className="rr__recent-button"
                    aria-label={label}
                    aria-pressed={selectedHandId === hand.hand_id}
                    disabled={lookupBusy}
                    onClick={() => void lookupHand(hand.hand_id)}
                  >
                    <strong className="sc-ink--silver">{titleCase(hand.table_name)}</strong>
                    <small className="sc-ink--muted">
                      {handNumber} - {recentHandTimeLabel(hand.created_at)}
                    </small>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {visibleLookupMessage && (
          <p
            className={`sc-copy sc-copy--center ${lookupState === 'not-found' ? 'sc-ink--muted' : 'sc-ink--red'}`}
            role={lookupState === 'not-found' ? 'status' : 'alert'}
          >
            {visibleLookupMessage}
          </p>
        )}

        {!breakdown && lookupState === 'idle' && (
          <p className="sc-copy sc-copy--center">
            Choose A Recent Raked Hand To Verify Its Player Allocation.
          </p>
        )}

        {breakdown && (
          <div className="rr__breakdown">
            <dl className="rr__facts" aria-label="Verified Hand Rake Summary">
              <div className="rr__fact">
                <dt className="sc-label sc-ink--blue">Rake Collected</dt>
                <dd className="sc-ink--silver">{chipLabel(breakdown.regular_rake_collected)}</dd>
              </div>
              <div className="rr__fact">
                <dt className="sc-label sc-ink--blue">Bad Beat Drop</dt>
                <dd className="sc-ink--silver">{chipLabel(breakdown.bbj_drop_collected)}</dd>
              </div>
              <div className="rr__fact">
                <dt className="sc-label sc-ink--blue">Method</dt>
                <dd className="sc-ink--silver">
                  {breakdown.rake_method === 'WEIGHTED_CONTRIBUTED'
                    ? 'Weighted Contributed'
                    : 'Dealt Equal'}
                </dd>
              </div>
              <div className="rr__fact">
                <dt className="sc-label sc-ink--blue">Reconciliation</dt>
                <dd className={breakdown.reconciliation.valid ? 'sc-ink--blue' : 'sc-ink--red'}>
                  {breakdown.reconciliation.valid ? 'Valid' : 'Mismatch'}
                </dd>
              </div>
            </dl>

            {breakdown.players.length === 0 ? (
              <p className="sc-copy sc-copy--center">No Player Allocation Rows Were Recorded.</p>
            ) : (
              <ol className="rr__list" aria-label="Player Rake Allocations">
                {breakdown.players.map((player, index) => (
                  <li className="rr__row" key={player.player_id}>
                    <span className="rr__rank sc-ink--gold">{index + 1}</span>
                    <span className="rr__row-copy">
                      <strong className="sc-ink--silver">Player {index + 1}</strong>
                      <small className="sc-ink--muted">
                        Eligible {chipLabel(player.eligible_contribution)}
                        {player.returned_uncalled !== null && player.returned_uncalled > 0
                          ? `, Returned ${chipLabel(player.returned_uncalled)}`
                          : ''}
                      </small>
                    </span>
                    <span className="rr__row-value sc-ink--blue">
                      Credit {chipLabel(player.weighted_rake_credit)}
                      <small>{weightLabel(player.contribution_weight)}</small>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {(selectedHandId !== null || lookupState !== 'idle') && (
          <button
            type="button"
            className="rr__word-action"
            disabled={lookupBusy}
            onClick={clearLookup}
          >
            Clear Selection
          </button>
        )}
      </SpadeConsole>
    </div>
  );
};

export default RakeReports;
