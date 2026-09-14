/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SATELLITES — one loader, one mapper, one registration query
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two surfaces show the satellites feeding a tournament: the Satellites tab and
 * Band 4 of the Detail tab. Until 2026-08-29 each had its own copy of the fetch
 * and its own byte-identical copy of the mapper, and every bug below was
 * therefore present twice.
 *
 * WHAT WAS WRONG WITH THE OLD MAPPER
 *
 *  1. `Number(sat.guarantee)` — there is no `guarantee` column on `tournaments`.
 *     The column is `guaranteed_prize`. `Number(undefined) || 0` is 0, so EVERY
 *     satellite card ever rendered showed a prize pool of zero, silently.
 *
 *  2. `Number(sat.blind_duration)` — no such column either. Always undefined,
 *     so the card's speed badge (Hyper / Turbo / Deep Stack) never appeared.
 *
 *  3. The mapper hardcoded regular speed. Structure labels now travel with
 *     engine-derived facts, keeping the printed label, badge, actual clock
 *     and independent starting depth consistent without printing raw JSON.
 *
 *  4. None of `late_reg_levels`, `late_reg_mins`, `current_level`,
 *     `started_at`, `starting_chips`, `is_rebuy`, `is_reentry`, `is_bounty`,
 *     `is_pko`, `is_mystery_bounty`, `bounty_amount`, `spin_multiplier` were
 *     passed, though the card accepts all of them and `select('*')` had already
 *     paid to fetch them. `hasLateReg` was therefore always false and no
 *     satellite card ever showed a late-registration countdown.
 *
 * AND WITH THE OLD LOADER
 *
 *  5. `if (!tournament?.id) return;` sat BEFORE the `try/finally`, while
 *     `loading` was initialised `true`. With no id the tab showed
 *     "Loading Satellites..." forever.
 *
 *  6. `select('*')` with no `.limit()`, pulling every column of every row.
 *
 *  7. N+1. Each `TournamentLobbyCard` runs its own `tournament_players`
 *     lookup on mount, so ten satellites cost eleven round trips — even though
 *     the caller already knows the viewer. One `.in()` query answers all of
 *     them, and the card takes the answer as a prop.
 *
 *  8. No retry. Once the error state was set the tab was a dead end.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import { describeStoredMttStructure } from '../../../../server/src/tournament/mttStructureDescription';
import { totalBuyIn } from '../../../utils/buyIn';

/**
 * Explicit column list. `select('*')` on `tournaments` pulls well over a
 * hundred columns per row, including the whole mystery-bounty configuration
 * block, for a card that renders about fifteen fields.
 */
export const SATELLITE_COLUMNS = [
  'id',
  'name',
  'status',
  'tournament_type',
  'game_type',
  /* NOT `buy_in`. There is no such column: the price is stored split, as
     `buy_in_amount` (the prize contribution) plus `buy_in_fee` (the rake), and
     what a player pays is the SUM. See src/utils/buyIn.ts. */
  'buy_in_amount',
  'buy_in_fee',
  'guaranteed_prize',
  'prize_pool',
  'max_players',
  'current_players',
  'start_time',
  'started_at',
  'starting_chips',
  'blind_structure',
  'current_level',
  'late_reg_levels',
  'late_reg_mins',
  'addon_levels',
  'is_rebuy',
  'is_reentry',
  'is_bounty',
  'is_pko',
  'is_mystery_bounty',
  'bounty_amount',
  'spin_multiplier',
].join(', ');

/** A satellite list is a handful of events, never a page of them. */
export const SATELLITE_LIMIT = 200;

const LIVE_STATUSES = ['ANNOUNCED', 'REGISTERING', 'LATE_REG', 'RUNNING'] as const;

export interface SatelliteRow {
  id: string;
  [key: string]: unknown;
}

type CardType = 'sng' | 'mtt' | 'satellite' | 'spin' | 'bounty' | 'pko' | 'mystery';
type CardStatus = 'registering' | 'running' | 'finished' | 'cancelled';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Opening playing-level minutes; zero means unavailable. */
export function firstLevelMinutes(blindStructure: unknown): number {
  return describeStoredMttStructure(blindStructure, 0).openingMinutes ?? 0;
}

/** Kept for existing callers; classification belongs to the engine policy. */
export function speedLabel(minutes: number): string {
  return describeStoredMttStructure([{ durationMinutes: minutes }], 0).speedLabel ?? 'Unconfirmed';
}

export function mapSatelliteRowToCard(sat: Record<string, unknown>) {
  const tournType = String(sat.tournament_type || '').toLowerCase();
  /**
   * Every row this mapper ever sees was selected by
   * `.eq('satellite_target_id', tournamentId)`, so it IS a satellite by
   * definition and that is the default. The old mapper tested `sat.is_satellite`
   * — a column that does not exist on `tournaments`, so the test was always
   * false and the type fell through to whatever came next, or to 'mtt'. The
   * query filter is the authority here; the type column only refines it.
   */
  let type: CardType = 'satellite';
  if (tournType === 'spin') type = 'spin';
  else if (tournType === 'sng') type = 'sng';
  else if (sat.is_mystery_bounty) type = 'mystery';
  else if (sat.is_pko) type = 'pko';
  else if (sat.is_bounty) type = 'bounty';

  let status: CardStatus = 'finished';
  const rawStatus = String(sat.status || '').toUpperCase();
  if (['ANNOUNCED', 'REGISTERING', 'LATE_REG'].includes(rawStatus)) status = 'registering';
  else if (rawStatus === 'RUNNING') status = 'running';
  else if (['CANCELLED', 'ABORTED'].includes(rawStatus)) status = 'cancelled';

  const structureFacts = describeStoredMttStructure(sat.blind_structure, sat.starting_chips);

  return {
    id: String(sat.id),
    name: String(sat.name || 'Satellite'),
    type,
    /* THE TOTAL A PLAYER PAYS, which is the card's documented contract for this
       field. `sat.buy_in` is not a column, so `Number(undefined) || 0` made
       every satellite card advertise a buy-in of ZERO alongside its prize pool
       of zero. `totalBuyIn` is the one place that adds the two halves. */
    buyIn: totalBuyIn(num(sat.buy_in_amount), num(sat.buy_in_fee)),
    /* The advertised guarantee where there is one, otherwise the pool actually
       collected. The old mapper read a column that does not exist and so always
       showed zero. */
    prizePool: num(sat.guaranteed_prize) || num(sat.prize_pool),
    guaranteedPrize: num(sat.guaranteed_prize) || undefined,
    blindStructure: structureFacts.speedLabel ?? 'Unconfirmed',
    blindDuration: structureFacts.openingMinutes ?? undefined,
    structureFacts,
    maxPlayers: num(sat.max_players),
    registeredPlayers: num(sat.current_players),
    startsAt: sat.start_time as string | undefined,
    started_at: sat.started_at as string | undefined,
    status,
    gameType: (sat.game_type as string) || undefined,
    startingChips: num(sat.starting_chips) || undefined,
    /* Late reg needs BOTH spellings: the card reads levels and minutes
       separately and treats either as enabling it. Passing neither is why no
       satellite card has ever shown a late-reg countdown. */
    late_reg_levels: num(sat.late_reg_levels) || undefined,
    late_reg_mins: num(sat.late_reg_mins) || undefined,
    current_level: num(sat.current_level) || undefined,
    addon_levels: num(sat.addon_levels) || undefined,
    isRebuy: Boolean(sat.is_rebuy),
    is_reentry: Boolean(sat.is_reentry),
    isBounty: Boolean(sat.is_bounty),
    isPko: Boolean(sat.is_pko),
    isMysteryBounty: Boolean(sat.is_mystery_bounty),
    bountyAmount: num(sat.bounty_amount) || undefined,
    spinMultiplier: num(sat.spin_multiplier) || undefined,
  };
}

export interface SatellitesState {
  /** Mapped cards, ready to hand straight to TournamentLobbyCard. */
  cards: ReturnType<typeof mapSatelliteRowToCard>[];
  /**
   * Registration per satellite id. `true`/`false` when the batch query
   * answered; `null` when it FAILED, which is not the same as "not registered"
   * and must never be rendered as a live Register button (see the 2026-08-25
   * note in TournamentLobbyCard).
   */
  registration: Record<string, boolean> | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useSatellites(
  tournamentId: string | undefined,
  currentUserId?: string | null
): SatellitesState {
  const [rows, setRows] = useState<SatelliteRow[]>([]);
  const [registration, setRegistration] = useState<Record<string, boolean> | null>(null);
  /* Not `true`. The old code initialised this true and then returned early
     when there was no id, before the finally that would have cleared it, so a
     tournament with no id showed a spinner for ever. Start false and let the
     effect turn it on for a load it is actually going to perform. */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const liveRequest = useRef(0);

  useEffect(() => {
    if (!tournamentId) {
      setRows([]);
      setRegistration(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const request = ++liveRequest.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .from('tournaments')
          .select(SATELLITE_COLUMNS)
          .eq('satellite_target_id', tournamentId)
          .in('status', LIVE_STATUSES as unknown as string[])
          .order('start_time', { ascending: true })
          .limit(SATELLITE_LIMIT);

        if (fetchErr) throw fetchErr;
        if (cancelled || request !== liveRequest.current) return;

        const sats = (data || []) as unknown as SatelliteRow[];
        setRows(sats);

        /* ONE registration query for the whole list, replacing one per card.
           A failure here leaves `registration` null so each card falls back to
           its own lookup rather than guessing. */
        if (!currentUserId || sats.length === 0) {
          setRegistration(currentUserId ? {} : null);
        } else {
          const { data: regRows, error: regErr } = await supabase
            .from('tournament_players')
            .select('tournament_id')
            .eq('user_id', currentUserId)
            .in(
              'tournament_id',
              sats.map((s) => s.id)
            );
          if (cancelled || request !== liveRequest.current) return;
          if (regErr) {
            reportError(regErr, 'useSatellites.registration');
            setRegistration(null);
          } else {
            const map: Record<string, boolean> = {};
            for (const s of sats) map[s.id] = false;
            for (const r of regRows || []) map[String(r.tournament_id)] = true;
            setRegistration(map);
          }
        }
      } catch (err) {
        reportError(err, 'useSatellites.fetch');
        if (!cancelled && request === liveRequest.current) {
          setError('Satellites Could Not Be Loaded');
          setRows([]);
          setRegistration(null);
        }
      } finally {
        if (!cancelled && request === liveRequest.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournamentId, currentUserId, attempt]);

  /* Mapped once per fetch, not once per render. The old code called the mapper
     inside `.map()` in the JSX, so every parent render — and the Detail tab
     re-renders once a SECOND — handed every memoised card a brand-new object
     prop and re-rendered all of them. */
  const cards = useMemo(() => rows.map(mapSatelliteRowToCard), [rows]);

  return { cards, registration, loading, error, retry };
}
