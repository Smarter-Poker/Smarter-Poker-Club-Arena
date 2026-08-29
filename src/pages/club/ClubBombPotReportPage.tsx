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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { downloadCsv, csvEscape } from '../../utils/downloadCsv';
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

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  (t && TRIGGER_LABEL[t]) || (t ? t.replace(/_/g, ' ') : 'Unknown');

const boardLabel = (n: number | null) => (n && n >= 2 ? `${n} Boards` : '1 Board');

export default function ClubBombPotReportPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('fn_club_bomb_pot_report', {
      p_club_id: clubId,
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

  if (denied) {
    return (
      <div className={styles.page}>
        <div className={styles.deniedCard}>
          <h1>Bomb Pot Report</h1>
          <p>This Report Is Only Available To Club Staff.</p>
          <button className={styles.backBtn} onClick={() => navigate(`/clubs/${clubId}`)}>
            Back To Club
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(`/clubs/${clubId}`)}>
          Back
        </button>
        <h1>Bomb Pot Report</h1>
        <div className={styles.windows}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={days === w ? styles.windowActive : styles.window}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </header>

      {loading && !rows ? (
        <p className={styles.empty}>Loading Report...</p>
      ) : error ? (
        <p className={styles.empty}>{error}</p>
      ) : !rows || rows.length === 0 ? (
        <p className={styles.empty}>
          No Bomb Pots Ran At This Club In The Last {days} Days. Turn Them On From A Table Settings
          Page To Start.
        </p>
      ) : (
        <>
          <section className={styles.cards}>
            <div className={styles.card}>
              <div className={styles.cardValue}>{totals.hands.toLocaleString()}</div>
              <div className={styles.cardLabel}>Bomb Pots Dealt</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{totals.tables}</div>
              <div className={styles.cardLabel}>Tables Running Them</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{totals.avgPlayers.toFixed(1)}</div>
              <div className={styles.cardLabel}>Players Per Bomb</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{chips(totals.antes)}</div>
              <div className={styles.cardLabel}>Forced Antes Collected</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>{chips(totals.rake)}</div>
              <div className={styles.cardLabel}>Rake From Bomb Pots</div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardValue}>
                {totals.scoopRate === null ? '-' : `${totals.scoopRate}%`}
              </div>
              <div className={styles.cardLabel}>Scooped Outright</div>
            </div>
          </section>

          {/* The ledger telling on itself. A report that quietly averages over
              hands it has no record of is how a hole stays invisible. */}
          {totals.unrecorded > 0 && (
            <p className={styles.notice}>
              {totals.unrecorded.toLocaleString()} Of These Hands Have No Award Record, So The Scoop
              Figures Above Cover The Rest. Hand Counts And Money Are Unaffected.
            </p>
          )}

          <section className={styles.tableSection}>
            <div className={styles.tableHeader}>
              <h2>Per Table</h2>
              <button className={styles.exportBtn} onClick={exportCsv}>
                Export CSV
              </button>
            </div>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Trigger</th>
                    <th>Boards</th>
                    <th>Hands</th>
                    <th>Players</th>
                    <th>Avg Pot</th>
                    <th>Antes</th>
                    <th>Rake</th>
                    <th>Scoops</th>
                    <th>Splits</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr
                      key={`${d.table_id}-${d.trigger_reason}-${d.board_count}-${d.variant ?? ''}`}
                    >
                      <td>{d.table_name || d.table_id.slice(0, 8)}</td>
                      <td>{triggerLabel(d.trigger_reason)}</td>
                      <td>
                        {boardLabel(d.board_count)}
                        {d.variant ? ` · ${d.variant.toUpperCase()}` : ''}
                      </td>
                      <td>{d.hands}</td>
                      <td>{d.avg_players == null ? '-' : Number(d.avg_players).toFixed(1)}</td>
                      <td>{chips(d.avg_pot)}</td>
                      <td>{chips(d.total_antes)}</td>
                      <td>{chips(d.total_rake)}</td>
                      <td>{d.scoops}</td>
                      <td>{d.splits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
