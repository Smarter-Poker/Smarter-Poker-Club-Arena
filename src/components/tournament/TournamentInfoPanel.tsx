/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT INFO PANEL (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "when you are in an MTT, spin or heads up and you click the stats
 * button in the upper right, it should show you the tournament details like
 * the attached images (tournament lobby and stats)."
 *
 * The button opened SESSION stats — stack, buy-in, hands played, VPIP. That is
 * the right card for a cash game and the wrong one for a tournament, where the
 * questions are "where am I", "what is left to play for", and "how long until
 * the blinds move".
 *
 * The reference lobby answers those with a header of standings numbers and
 * four tabs, so that is what this is: My Position / Entries / Prize Pool /
 * Bounty Pool / Level / Late Reg / Avg / Largest / Smallest stack, over
 * Ranking, Prizes, Tables and Blinds.
 *
 * Everything is derived from rows the client may already read — tournaments,
 * tournament_players, tables — so the panel adds no new privileged surface.
 * It is fully self-contained: one query on open, one light refresh while it is
 * open, and it unsubscribes on close.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { money } from '../../utils/buyIn';
import './TournamentInfoPanel.css';

type TabId = 'ranking' | 'prizes' | 'tables' | 'blinds';

interface Row {
  user_id: string;
  username: string | null;
  chips: number | null;
  status: string | null;
  position: number | null;
  prize: number | null;
  rebuys: number | null;
  bounties_collected: number | null;
  table_id: string | null;
}

interface TournamentRow {
  id: string;
  name: string;
  status: string;
  variant: string | null;
  buy_in_amount: number | null;
  buy_in_fee: number | null;
  prize_pool: number | null;
  guaranteed_prize: number | null;
  bounty_pool: number | null;
  current_players: number | null;
  max_players: number | null;
  starting_chips: number | null;
  current_level: number | null;
  level_started_at: string | null;
  late_reg_levels: number | null;
  blind_structure: unknown;
  payout_structure: unknown;
  is_bounty: boolean | null;
  start_time: string | null;
}

interface Props {
  tournamentId: string;
  heroUserId?: string;
  onClose: () => void;
}

function asArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default function TournamentInfoPanel({ tournamentId, heroUserId, onClose }: Props) {
  const [tab, setTab] = useState<TabId>('ranking');
  const [t, setT] = useState<TournamentRow | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A FAILED QUERY IS NOT AN EMPTY TOURNAMENT (2026-08-25).
   *
   * This panel destructured only `data` from both queries. supabase-js does not
   * throw on a query error, it RETURNS one, so the try/catch never saw it: a
   * dropped connection, an RLS refusal or a bad column name all arrived here as
   * `data: null`, `setRows([])` ran, `loading` flipped false, and the panel
   * rendered "No Players Seated Yet." over a running tournament with the
   * masthead reading 0 entries and a prize pool of nothing.
   *
   * "We asked and the answer is none" and "we could not ask" now have separate
   * states, and the second one says so instead of impersonating the first.
   */
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tRes, pRes] = await Promise.all([
        supabase
          .from('tournaments')
          .select(
            'id, name, status, variant, buy_in_amount, buy_in_fee, prize_pool, guaranteed_prize, bounty_pool, current_players, max_players, starting_chips, current_level, level_started_at, late_reg_levels, blind_structure, payout_structure, is_bounty, start_time'
          )
          .eq('id', tournamentId)
          .maybeSingle(),
        supabase
          .from('tournament_players')
          .select(
            'user_id, username, chips, status, position, prize, rebuys, bounties_collected, table_id'
          )
          .eq('tournament_id', tournamentId)
          .limit(500),
      ]);

      if (tRes.error || pRes.error) {
        reportError(tRes.error ?? pRes.error, 'TournamentInfoPanel.load');
        // Keep whatever was already on screen. A refresh tick that fails must
        // not blank a panel that was correct a moment ago.
        setFailed(true);
        return;
      }

      setFailed(false);
      if (tRes.data) setT(tRes.data as TournamentRow);
      setRows((pRes.data as Row[]) ?? []);
    } catch (err) {
      reportError(err, 'TournamentInfoPanel.load');
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
    // Light refresh while open — the panel is a lobby view, not a live feed.
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Close on Escape, the way every other dismissible surface here behaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = useMemo(() => {
    const alive = rows.filter((r) => r.status === 'playing' || r.status === 'registered');
    const stacks = alive.map((r) => num(r.chips)).filter((n) => n > 0);
    const mine = heroUserId ? rows.find((r) => r.user_id === heroUserId) : undefined;
    const ranked = [...alive].sort((a, b) => num(b.chips) - num(a.chips));
    const myRank = mine ? ranked.findIndex((r) => r.user_id === mine.user_id) + 1 : 0;
    const pool = Math.max(num(t?.prize_pool), num(t?.guaranteed_prize));
    return {
      entriesAlive: alive.length,
      entriesTotal: rows.length,
      prizePool: pool,
      bountyPool: num(t?.bounty_pool),
      avg: stacks.length ? Math.round(stacks.reduce((a, b) => a + b, 0) / stacks.length) : 0,
      largest: stacks.length ? Math.max(...stacks) : 0,
      smallest: stacks.length ? Math.min(...stacks) : 0,
      rebuys: rows.reduce((n, r) => n + num(r.rebuys), 0),
      myRank,
      myPosition: mine?.position ?? null,
      myStatus: mine?.status ?? null,
      ranked,
    };
  }, [rows, t, heroUserId]);

  const blinds = useMemo(() => asArray(t?.blind_structure), [t]);
  const payouts = useMemo(() => asArray(t?.payout_structure), [t]);
  /**
   * LEVEL DISPLAY IS 1-BASED, THE COLUMN IS NOT (2026-08-23).
   *
   * tournaments.current_level is a 0-BASED index into blind_structure — the
   * engine's TournamentManagerBase.currentLevel starts at 0 and indexes the
   * array directly, so blind_structure[current_level].level === current_level
   * + 1. TablePage already documents and honours this.
   *
   * This panel rendered the raw index as the level number, and `|| 1` on top
   * of it. So index 0 showed "Level 1" and index 1 ALSO showed "Level 1" —
   * the number visibly failed to go up when the blinds did — and from there on
   * the panel was permanently one behind the blinds actually being posted.
   * Part of "levels don't go up as they should" was this line: on a healthy
   * engine the masthead still lied.
   */
  const level = num(t?.current_level) + 1;
  /**
   * Late reg is closed once the level index REACHES the cap (indices 0..N-1
   * are the N advertised levels), the same instant
   * TournamentManagerBase.isLateRegClosed uses. This stat used to print the
   * configured cap forever, and only ever said "Closed" for a tournament that
   * had no late registration at all — so it never reported the thing it exists
   * to report.
   */
  const lateRegCap = num(t?.late_reg_levels);
  const lateRegClosed = lateRegCap <= 0 || num(t?.current_level) >= lateRegCap;

  const tables = useMemo(() => {
    const byTable = new Map<string, number>();
    for (const r of rows) {
      if (r.status !== 'playing' || !r.table_id) continue;
      byTable.set(r.table_id, (byTable.get(r.table_id) ?? 0) + 1);
    }
    return [...byTable.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  /**
   * Until the tournament row is actually in hand, every derived number here is
   * a zero we invented. `money(0)` and "0 / 0" read as facts about a real
   * tournament, so they print as "-" instead until there is something to print.
   */
  const known = t !== null;

  const stat = (label: string, value: string) => (
    <div className="tip__stat">
      <span className="tip__statLabel">{label}</span>
      <span className="tip__statValue">{known ? value : '-'}</span>
    </div>
  );

  return (
    <div className="tip__scrim" onClick={onClose} role="presentation">
      <section
        className="tip"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Tournament Information"
      >
        <header className="tip__head">
          <div className="tip__title">{t?.name || 'Tournament'}</div>
          <button className="tip__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="tip__statGrid">
          {stat(
            'My Position',
            stats.myStatus === 'eliminated'
              ? `Out ${stats.myPosition ? `(${stats.myPosition})` : ''}`.trim()
              : stats.myRank
                ? `${stats.myRank} / ${stats.entriesAlive}`
                : 'Not Entered'
          )}
          {stat('Entries', `${stats.entriesAlive} / ${stats.entriesTotal}`)}
          {stat('Prize Pool', money(stats.prizePool))}
          {stat(
            t?.is_bounty ? 'Bounty Pool' : 'Buy-In',
            t?.is_bounty
              ? money(stats.bountyPool)
              : money(num(t?.buy_in_amount) + num(t?.buy_in_fee))
          )}
          {stat('Level', String(level))}
          {stat('Late Reg', lateRegClosed ? 'Closed' : `Through Level ${lateRegCap}`)}
          {stat('Avg Stack', stats.avg.toLocaleString())}
          {stat('Largest', stats.largest.toLocaleString())}
          {stat('Smallest', stats.smallest.toLocaleString())}
        </div>

        <nav className="tip__tabs" role="tablist">
          {(['ranking', 'prizes', 'tables', 'blinds'] as TabId[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tip__tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {id === 'ranking'
                ? 'Ranking'
                : id === 'prizes'
                  ? 'Prizes'
                  : id === 'tables'
                    ? 'Tables'
                    : 'Blinds'}
            </button>
          ))}
        </nav>

        <div className="tip__body">
          {loading && rows.length === 0 && !failed && <div className="tip__empty">Loading...</div>}

          {/* We could not ask. Never dressed up as "the answer is none". */}
          {failed && (
            <div className="tip__error" role="status">
              Could Not Load Tournament Details. Retrying.
            </div>
          )}

          {tab === 'ranking' && (
            <table className="tip__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="tip__num">Chips</th>
                  {t?.is_bounty && <th className="tip__num">KO</th>}
                </tr>
              </thead>
              <tbody>
                {stats.ranked.map((r, i) => (
                  <tr
                    key={r.user_id}
                    className={heroUserId && r.user_id === heroUserId ? 'is-me' : ''}
                  >
                    <td>{i + 1}</td>
                    <td className="tip__name">{r.username || 'Player'}</td>
                    <td className="tip__num">{num(r.chips).toLocaleString()}</td>
                    {t?.is_bounty && <td className="tip__num">{num(r.bounties_collected)}</td>}
                  </tr>
                ))}
                {!loading && !failed && stats.ranked.length === 0 && (
                  <tr>
                    <td colSpan={4} className="tip__empty">
                      No Players Seated Yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {tab === 'prizes' && (
            <table className="tip__table">
              <thead>
                <tr>
                  <th>Place</th>
                  <th className="tip__num">Share</th>
                  <th className="tip__num">Prize</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p, i) => {
                  const pct = num(p.percentage);
                  return (
                    <tr key={i}>
                      <td>{num(p.place) || i + 1}</td>
                      <td className="tip__num">{pct}%</td>
                      <td className="tip__num">
                        {money(Math.round((stats.prizePool * pct) / 100))}
                      </td>
                    </tr>
                  );
                })}
                {!failed && payouts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="tip__empty">
                      Payouts Are Set When Registration Closes.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {tab === 'tables' && (
            <table className="tip__table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="tip__num">Players</th>
                </tr>
              </thead>
              <tbody>
                {tables.map(([id, n]) => (
                  <tr key={id}>
                    <td className="tip__name">Table {id.slice(0, 8)}</td>
                    <td className="tip__num">{n}</td>
                  </tr>
                ))}
                {!failed && tables.length === 0 && (
                  <tr>
                    <td colSpan={2} className="tip__empty">
                      Tables Are Built When The Tournament Starts.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {tab === 'blinds' && (
            <table className="tip__table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th className="tip__num">Blinds</th>
                  <th className="tip__num">Ante</th>
                  <th className="tip__num">Mins</th>
                </tr>
              </thead>
              <tbody>
                {blinds.map((b, i) => {
                  const lvl = num(b.level) || i + 1;
                  const isBreak = Boolean(b.isBreak);
                  return (
                    <tr key={i} className={lvl === level ? 'is-me' : ''}>
                      <td>{isBreak ? 'Break' : lvl}</td>
                      <td className="tip__num">
                        {isBreak
                          ? '-'
                          : `${num(b.smallBlind).toLocaleString()}/${num(b.bigBlind).toLocaleString()}`}
                      </td>
                      <td className="tip__num">
                        {num(b.ante) ? num(b.ante).toLocaleString() : '-'}
                      </td>
                      <td className="tip__num">
                        {num(b.durationMinutes) || num(b.duration) / 60 || '-'}
                      </td>
                    </tr>
                  );
                })}
                {!failed && blinds.length === 0 && (
                  <tr>
                    <td colSpan={4} className="tip__empty">
                      No Blind Structure Recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
