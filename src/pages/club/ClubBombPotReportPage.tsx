/**
 * CLUB BOMB POT REPORT (2026-08-29)
 * ============================================================================
 * The club staff's view of their own bomb pots: which tables run them, under
 * which trigger, how many players each one pulls in, how much forced money it
 * moves, and how often somebody scoops.
 *
 * WHY THIS PAGE EXISTS. The platform already had three bomb-pot views
 * (v_bomb_pot_daily, v_bomb_pot_vs_normal, v_bomb_pot_outcomes) and not one of
 * them carries club_id or table_id — they aggregate across the WHOLE platform.
 * They were operator views wearing a club-analytics label, no UI read any of
 * them, and until 2026-08-29 they were readable by anon into the bargain. A
 * club owner could not answer the first question anybody asks about a forced
 * ante: is it bringing players to my tables or driving them away.
 *
 * Data: fn_club_bomb_pot_report — SECURITY DEFINER, gated server-side on the
 * same owner / co_owner / admin test fn_request_manual_bomb_pot uses, raising
 * ERRCODE 42501 like its siblings. The client gate below is cosmetic.
 *
 * `unrecorded_hands` is deliberately on the face of the page rather than
 * buried: it is the count of bomb hands with no award-unit rows, which is the
 * same hole fn_bomb_pot_ledger_gaps reports to reconcile_ledger_nightly. A
 * non-zero number there means this report is reading an incomplete ledger, and
 * the owner should be told that rather than shown a total that looks whole.
 *
 * #ClubArenaConsole: one console. The window as lit words, the six totals as
 * rows on the black glass, the per-table records as rows between engraved
 * rules (never HTML-table chrome), Back and Export CSV on the two painted
 * plates. Every read, guard and pinned literal of the generic page is kept.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
import { SpadeConsole } from '../../components/console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import styles from './ClubBombPotReportPage.module.css';

interface ReportRow {
  table_id: string;
  table_name: string | null;
  trigger_reason: string | null;
  board_count: number | null;
  variant: string | null;
  hands: number;
  avg_players: number | null;
  avg_pot: number | null;
  total_pot: number | null;
  total_rake: number | null;
  total_antes: number | null;
  scoops: number;
  splits: number;
  unrecorded_hands: number;
}

const WINDOWS = [7, 30, 90] as const;

/* Report money is forward-facing and reads compact (Dan: no decimals, 1.2K
   past a thousand). The CSV below still carries the exact figures. */
const chips = (n: number | null | undefined) => compactChips(Number(n ?? 0));

/**
 * The four trigger values are DB enums. The lobby maps them to English and the
 * replay does too; a report is no place to print `every_n_hands` at a club
 * owner either.
 */
const TRIGGER_LABEL: Record<string, string> = {
  every_n_hands: 'Scheduled',
  once_per_orbit: 'Every Orbit',
  timed: 'On The Clock',
  bomb_pot_only: 'Bomb Pot Table',
  manual_next_hand: 'Called By The Host',
};

const triggerLabel = (t: string | null) =>
  (t && TRIGGER_LABEL[t]) || (t ? titleCase(t.replace(/_/g, ' ')) : 'Unknown');

const boardLabel = (n: number | null) => (n && n >= 2 ? `${n} Boards` : '1 Board');

export default function ClubBombPotReportPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);
    setError(null);
    // The route carries the club's SLUG (clubs/deep-stack-society-11192/...)
    // and this handed it to a uuid argument, so on every slug URL the RPC
    // answered 22P02 and the page said "Could Not Load". Resolve first, and
    // name a club that does not exist as one.
    let resolved: string;
    try {
      const { resolveClubUUIDStrict } = await import('../../utils/strictClubIdResolver');
      resolved = await resolveClubUUIDStrict(clubId);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'ClubNotFoundError') {
        setNotFound(true);
      } else {
        reportError(e, 'ClubBombPotReportPage.Resolve_failed');
        setError('The Club Could Not Be Resolved');
      }
      setLoading(false);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc('fn_club_bomb_pot_report', {
      p_club_id: resolved,
      p_days: days,
    });
    if (rpcError) {
      if (isAuthzError(rpcError)) {
        setDenied(true);
      } else {
        reportError(rpcError, 'ClubBombPotReportPage.Load_failed');
        setError('Could Not Load The Bomb Pot Report');
      }
      setRows(null);
    } else {
      setRows((data ?? []) as ReportRow[]);
    }
    setLoading(false);
  }, [clubId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const r = rows ?? [];
    const hands = r.reduce((s, x) => s + Number(x.hands ?? 0), 0);
    const scoops = r.reduce((s, x) => s + Number(x.scoops ?? 0), 0);
    const splits = r.reduce((s, x) => s + Number(x.splits ?? 0), 0);
    const antes = r.reduce((s, x) => s + Number(x.total_antes ?? 0), 0);
    const rake = r.reduce((s, x) => s + Number(x.total_rake ?? 0), 0);
    const pot = r.reduce((s, x) => s + Number(x.total_pot ?? 0), 0);
    const unrecorded = r.reduce((s, x) => s + Number(x.unrecorded_hands ?? 0), 0);
    // Weighted by hands, so a table that ran three bombs does not count as
    // much as one that ran three hundred.
    const weightedPlayers = r.reduce(
      (s, x) => s + Number(x.avg_players ?? 0) * Number(x.hands ?? 0),
      0
    );
    return {
      hands,
      scoops,
      splits,
      antes,
      rake,
      pot,
      unrecorded,
      tables: new Set(r.map((x) => x.table_id)).size,
      avgPlayers: hands > 0 ? weightedPlayers / hands : 0,
      // Of the hands whose outcome the ledger actually recorded.
      scoopRate: scoops + splits > 0 ? Math.round((scoops / (scoops + splits)) * 100) : null,
    };
  }, [rows]);

  const exportCsv = useCallback(() => {
    if (!rows) return;
    const header =
      'table,trigger,boards,variant,hands,avg_players,avg_pot,total_pot,total_rake,total_antes,scoops,splits,unrecorded';
    const body = rows.map((d) =>
      [
        d.table_name ?? d.table_id,
        triggerLabel(d.trigger_reason),
        d.board_count ?? 1,
        d.variant ?? '',
        d.hands,
        d.avg_players ?? '',
        d.avg_pot ?? '',
        d.total_pot ?? '',
        d.total_rake ?? '',
        d.total_antes ?? '',
        d.scoops,
        d.splits,
        d.unrecorded_hands,
      ]
        .map((v) => csvEscape(String(v)))
        .join(',')
    );
    downloadCsv(`bomb-pot-report-${clubId}-${days}d.csv`, [header, ...body].join('\n'));
  }, [rows, clubId, days]);

  if (notFound) {
    return (
      <div className={styles.page}>
        <SpadeConsole
          className={styles.console}
          eyebrow="Bomb Pots"
          title="Club Not Found"
          titleId="bomb-pot-report-title"
          pill="Missing"
          pillInk="muted"
          foot="foot"
        >
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            No Club Answers To That Address.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => navigate('/clubs')}
            >
              Back To Clubs
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  if (denied) {
    return (
      <div className={styles.page}>
        <SpadeConsole
          className={styles.console}
          eyebrow="Bomb Pots"
          title="Bomb Pot Report"
          titleId="bomb-pot-report-title"
          pill="Staff"
          pillInk="red"
          foot="foot"
        >
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            This Report Is Only Available To Club Staff.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => navigate(`/clubs/${clubId}`)}
            >
              Back To Club
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <SpadeConsole
        className={styles.console}
        eyebrow="Bomb Pots"
        title="Bomb Pot Report"
        titleId="bomb-pot-report-title"
        pill={`${days} Days`}
        pillInk="blue"
        plates={{
          secondary: { label: 'Back', onClick: () => navigate(`/clubs/${clubId}`) },
          primary: {
            label: 'Export CSV',
            ink: 'white',
            onClick: exportCsv,
            disabled: !rows || rows.length === 0,
          },
        }}
      >
        <div className={styles.windows} role="group" aria-label="Report Window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.word} ${days === w ? 'sc-ink--white' : 'sc-ink--muted'}`}
              aria-pressed={days === w}
              onClick={() => setDays(w)}
            >
              {w} Days
            </button>
          ))}
        </div>

        {loading && !rows ? (
          <p className={`sc-copy sc-copy--center ${styles.state}`} aria-busy="true">
            Loading Report...
          </p>
        ) : error ? (
          <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="alert">
            {error}
          </p>
        ) : !rows || rows.length === 0 ? (
          <p className={`sc-copy sc-copy--center ${styles.state}`}>
            No Bomb Pots Ran At This Club In The Last {days} Days. Turn Them On From A Table
            Settings Page To Start.
          </p>
        ) : (
          <>
            <section className={styles.section} aria-label="Totals">
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Bomb Pots Dealt</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {totals.hands.toLocaleString()}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Tables Running Them</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>{totals.tables}</span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Players Per Bomb</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {totals.avgPlayers.toFixed(1)}
                </span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Forced Antes Collected</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>{chips(totals.antes)}</span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Rake From Bomb Pots</span>
                <span className={`${styles.rowValue} sc-ink--green`}>{chips(totals.rake)}</span>
              </div>
              <div className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--blue`}>Scooped Outright</span>
                <span className={`${styles.rowValue} sc-ink--silver`}>
                  {totals.scoopRate === null ? '-' : `${totals.scoopRate}%`}
                </span>
              </div>
            </section>

            {/* The ledger telling on itself. A report that quietly averages over
                hands it has no record of is how a hole stays invisible. */}
            {totals.unrecorded > 0 && (
              <p className={`sc-copy ${styles.notice} sc-ink--gold`}>
                {totals.unrecorded.toLocaleString()} Of These Hands Have No Award Record, So The
                Scoop Figures Above Cover The Rest. Hand Counts And Money Are Unaffected.
              </p>
            )}

            <section className={styles.section} aria-labelledby="bomb-pot-per-table">
              <h2
                id="bomb-pot-per-table"
                className={`${styles.sectionTitle} sc-label sc-ink--silver`}
              >
                Per Table
              </h2>
              <ul className={styles.records}>
                {rows.map((d) => (
                  <li
                    key={`${d.table_id}-${d.trigger_reason}-${d.board_count}-${d.variant ?? ''}`}
                    className={styles.record}
                  >
                    <div className={styles.recordHead}>
                      <span className={`${styles.recordName} sc-ink--silver`}>
                        {d.table_name
                          ? titleCase(d.table_name)
                          : `Table ${d.table_id.slice(0, 8).toUpperCase()}`}
                      </span>
                      <span className={`${styles.recordMeta} sc-ink--blue`}>
                        {triggerLabel(d.trigger_reason)}
                        {' / '}
                        {boardLabel(d.board_count)}
                        {d.variant ? ` / ${d.variant.toUpperCase()}` : ''}
                      </span>
                    </div>
                    <dl className={styles.figures}>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Hands</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>{d.hands}</dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Players</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>
                          {d.avg_players == null ? '-' : Number(d.avg_players).toFixed(1)}
                        </dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Avg Pot</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>
                          {chips(d.avg_pot)}
                        </dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Antes</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>
                          {chips(d.total_antes)}
                        </dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Rake</dt>
                        <dd className={`${styles.figureValue} sc-ink--green`}>
                          {chips(d.total_rake)}
                        </dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Scoops</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>{d.scoops}</dd>
                      </div>
                      <div className={styles.figure}>
                        <dt className={`${styles.figureLabel} sc-ink--muted`}>Splits</dt>
                        <dd className={`${styles.figureValue} sc-ink--silver`}>{d.splits}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </SpadeConsole>
    </div>
  );
}
