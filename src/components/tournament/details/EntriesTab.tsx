/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ENTRIES — who is in this event, in the order they entered
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "ENTRIES SHOULD LIST ALL THE PLAYERS IN ORDER OF
 * REGISTRATION, IT SHOULD INCLUDE THEIR AVATAR AND PLAYER ID NUMBER (NOT
 * CURRENT CHIP COUNT). IT SHOULD ALSO INCLUDE NUMBER OF REBUYS / ADD-ONS."
 *
 * The tab this replaces sorted by chip count and printed a chip count on every
 * row, which made it a second, slightly-disagreeing copy of the Ranking tab.
 * There is NO chip figure anywhere in this file, deliberately. Chips are a
 * live, changing number and they belong on exactly one surface; the entry list
 * is a register, and a register does not re-order itself while you read it.
 *
 * ── WHERE THE DATA ACTUALLY COMES FROM (verified against production, not
 *    assumed — the migration history and the live schema disagree in one place
 *    that matters, see REBUYS below) ─────────────────────────────────────────
 *
 *   registration time  tournament_players.registered_at  (timestamptz)
 *                      supabase/migrations/001_club_arena_schema.sql:433
 *   player id number   profiles.player_number            (text, 1022/1022 set)
 *                      NOT on tournament_players — hence the one join below.
 *   rebuys             tournament_players.rebuys         (integer)
 *                      001_club_arena_schema.sql:431
 *   add-on             tournament_players.add_on         (BOOLEAN, not a count)
 *                      001_club_arena_schema.sql:432
 *   avatar             profiles.arena_avatar_url         (aliased avatar_url,
 *                      the house convention everywhere)
 *
 * REBUYS, the honest version: migration 007 defines a `tournament_rebuys`
 * ledger with a type of 'rebuy' | 'addon', which would give a real per-player
 * add-on COUNT. That table DOES NOT EXIST in production (`to_regclass` returns
 * null). So the only add-on record that exists is one boolean per player, and
 * this tab reports it as taken / not taken rather than inventing a count it
 * cannot source. Field total for add-ons is therefore "players who took one".
 *
 * ── WHY THIS TAB QUERIES AT ALL ────────────────────────────────────────────
 *
 * types.ts is right that a tab should prefer its props. But the page's entry
 * query (TournamentDetails.tsx:540) selects only
 * `id, user_id, username, chips, status, position, table_id` — it hardcodes
 * `avatar_url: null` and never reads registered_at, rebuys, add_on or the
 * player number. Three of the four things Dan asked for are simply not in the
 * props yet. So: ONE query, for the whole field, joined through the
 * `fk_tournament_players_user_id_profiles` foreign key. Never one per row.
 *
 * If that query fails or has not landed yet the tab still renders every entry
 * from props, in the order the page supplied — which is already
 * `.order('registered_at')`. Degraded, never blank.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import type { TournamentTabProps, TournamentEntry } from './types';
import { initials } from './types';
import SatelliteSeatBadge from './SatelliteSeatBadge';
import '../../../styles/tournament-lobby-3d.css';
import './EntriesTab.css';

/** What the one field-wide query adds on top of the props. */
interface EntryDetail {
  registeredAt: string | null;
  playerNumber: string | null;
  avatarUrl: string | null;
  rebuys: number;
  addOn: boolean;
  isSatelliteQualifier?: boolean;
}

/**
 * Tournament flags this tab reads. `Tournament` in database.types.ts does not
 * declare all of them (is_rebuy, add_on_available and max_rebuys are live
 * columns that never made it into the generated type), so they are read
 * through one narrow local shape rather than by widening a type file this tab
 * does not own.
 */
interface EntryRules {
  is_rebuy?: boolean | null;
  add_on_available?: boolean | null;
  is_reentry?: boolean | null;
  max_rebuys?: number | null;
  max_reentries?: number | null;
}

/**
 * A public id we can show. Prefers a real player number; falls back to a
 * shortened user id ONLY so a row is never anonymous.
 *
 * The fallback is visually distinct on purpose (no "No." prefix) so nobody
 * mistakes a truncated uuid for an assigned player number.
 */
function publicId(entry: TournamentEntry, detail?: EntryDetail): string | null {
  const code = entry.player_code || detail?.playerNumber;
  if (code) return `No. ${code}`;
  if (entry.user_id) return entry.user_id.slice(0, 8).toUpperCase();
  return null;
}

export default function EntriesTab({ tournament, entries, onWatchPlayer }: TournamentTabProps) {
  const [details, setDetails] = useState<Record<string, EntryDetail>>({});
  /**
   * Whether the one detail query has landed.
   *
   * This exists because of a named house bug: a query that FAILED must never be
   * drawn as a field that is empty. Rebuys and add-ons live only in that query,
   * so on a rebuy event whose query was refused, the totals below are genuinely
   * unknown - and a tile reading "0" says, wrongly and confidently, that nobody
   * rebought. `unknown` prints a dash and a line saying why (2026-08-26 audit).
   */
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'unknown'>('loading');

  const tournamentId = tournament?.id;

  /* One query. Whole field. Cancelled on unmount, tolerant of an empty result.

     LIVE REGISTER (2026-08-30): the query used to run exactly once, so a
     register left open during a running event froze — new entries appeared
     (props refresh) but their numbers, rebuys and add-ons never did, and the
     rebuy total sat stale while the field rebought around it. While the event
     can still change (REGISTERING/RUNNING) the same one query re-runs every
     20s, and only while the tab is actually visible — a background tab costs
     nothing. A finished event runs it once, as before: its register is
     history and history does not poll. */
  const tournamentLive = ((tournament ?? {}) as { status?: string | null }).status
    ? ['REGISTERING', 'RUNNING', 'ANNOUNCED'].includes(
        String((tournament as { status?: string | null }).status).toUpperCase()
      )
    : false;

  useEffect(() => {
    if (!tournamentId) {
      setDetailState('unknown');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setDetailState('loading');

    const run = async () => {
      try {
        const { data, error } = await supabase
          .from('tournament_players')
          .select(
            'id, user_id, registered_at, rebuys, add_on, is_satellite_qualifier, profile:profiles!user_id(player_number, avatar_url:arena_avatar_url)'
          )
          .eq('tournament_id', tournamentId)
          .order('registered_at', { ascending: true });

        if (cancelled) return;
        if (error) {
          /* The list still renders from props, in the page's registered_at
             order. A missing player number is worth less than a blank tab. */
          reportError(error, 'EntriesTab.Failed_to_load_entry_detail');
          setDetailState('unknown');
          return;
        }

        const next: Record<string, EntryDetail> = {};
        for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
          /* PostgREST returns an embedded row as an object, but as an array
             when it cannot prove the relationship is to-one. Handle both —
             this exact shape caused bugs in the past. */
          const embedded = row.profile;
          const profile = (Array.isArray(embedded) ? embedded[0] : embedded) as
            | { player_number?: string | null; avatar_url?: string | null }
            | null
            | undefined;

          next[String(row.id)] = {
            registeredAt: (row.registered_at as string | null) ?? null,
            playerNumber: profile?.player_number ? String(profile.player_number) : null,
            avatarUrl: profile?.avatar_url || null,
            rebuys: Number(row.rebuys) || 0,
            addOn: row.add_on === true,
            isSatelliteQualifier: Boolean(row.is_satellite_qualifier),
          };
        }
        setDetails(next);
        setDetailState('ready');
      } catch (e) {
        if (cancelled) return;
        reportError(e, 'EntriesTab.Failed_to_load_entry_detail');
        setDetailState('unknown');
      }
    };

    const schedule = () => {
      if (cancelled || !tournamentLive) return;
      timer = setTimeout(async () => {
        /* Hidden tab: skip the round trip, keep the cadence. */
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          await run();
        }
        schedule();
      }, 20_000);
    };

    void run().then(schedule);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tournamentId, tournamentLive]);

  const rules = (tournament ?? {}) as unknown as EntryRules;

  /**
   * Registration order, strictly ascending.
   *
   * Rows that carry a timestamp sort by it. Rows that do not — legacy rows, or
   * every row before the detail query lands — sort AFTER them, holding the
   * order the page gave us (which is itself `.order('registered_at')`) and
   * falling back to id only to break a genuine tie. The list therefore never
   * jumbles: it either knows the times or it trusts the order it was handed.
   */
  const ordered = useMemo(() => {
    const withIndex = entries.map((entry, index) => {
      const detail = details[entry.id];
      const stamp = detail?.registeredAt ?? entry.created_at ?? null;
      const ms = stamp ? Date.parse(stamp) : NaN;
      return { entry, index, ms: Number.isFinite(ms) ? ms : null };
    });

    withIndex.sort((a, b) => {
      if (a.ms !== null && b.ms !== null) {
        if (a.ms !== b.ms) return a.ms - b.ms;
        return a.index - b.index;
      }
      if (a.ms !== null) return -1;
      if (b.ms !== null) return 1;
      if (a.index !== b.index) return a.index - b.index;
      return a.entry.id.localeCompare(b.entry.id);
    });

    return withIndex.map((w) => w.entry);
  }, [entries, details]);

  /**
   * Re-entries. `tournament_players` carries
   * UNIQUE(tournament_id, user_id), so a second row for the same player cannot
   * exist today — this marks the later rows the moment that constraint is
   * relaxed for a genuine re-entry event, so the list is never misread as
   * showing the same person twice by mistake.
   */
  const reentryIds = useMemo(() => {
    const seen = new Set<string>();
    const later = new Set<string>();
    for (const entry of ordered) {
      if (!entry.user_id) continue;
      if (seen.has(entry.user_id)) later.add(entry.id);
      else seen.add(entry.user_id);
    }
    return later;
  }, [ordered]);

  const totals = useMemo(() => {
    let rebuys = 0;
    let addOns = 0;
    for (const entry of ordered) {
      const detail = details[entry.id];
      rebuys += detail?.rebuys ?? entry.rebuys ?? 0;
      if (detail?.addOn || (entry.add_ons ?? 0) > 0) addOns += 1;
    }
    return {
      rebuys,
      addOns,
      uniquePlayers: new Set(ordered.map((e) => e.user_id).filter(Boolean)).size,
    };
  }, [ordered, details]);

  /* Columns appear because the event uses them, or because the data already
     proves it did. A column of zeros tells a player nothing except that we
     could not decide whether to show it. */
  const showRebuys = rules.is_rebuy === true || totals.rebuys > 0;
  const showAddOns = rules.add_on_available === true || totals.addOns > 0;
  const showUnique = rules.is_reentry === true || totals.uniquePlayers !== ordered.length;

  /* Rebuy and add-on figures come ONLY from the detail query. If it did not
     land, the honest answer is a dash. */
  const countsKnown = detailState === 'ready';
  const countText = (n: number) => (countsKnown ? n.toLocaleString() : '-');

  if (ordered.length === 0) {
    return (
      <section className="tl-panel et-panel" aria-labelledby="et-heading">
        <div className="tl-section-head">
          <h3 id="et-heading" className="tl-section-title">
            Entries
          </h3>
        </div>
        <div className="tl-empty">
          <span>No Entries Yet</span>
          <span className="tl-empty__hint">
            The Register Opens The Moment The First Player Takes A Seat
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="tl-panel et-panel" aria-labelledby="et-heading">
      <div className="tl-section-head">
        <h3 id="et-heading" className="tl-section-title">
          Entries
        </h3>
        <span className="tl-section-note">In Order Of Registration</span>
      </div>

      <div className="tl-stat-grid et-stats">
        <div className="tl-stat">
          <span className="tl-stat__label">Entries</span>
          <span className="tl-stat__value tl-stat__value--accent">
            {ordered.length.toLocaleString()}
          </span>
        </div>

        {showUnique && (
          <div className="tl-stat">
            <span className="tl-stat__label">Players</span>
            <span className="tl-stat__value">{totals.uniquePlayers.toLocaleString()}</span>
            {/* Dan 2026-08-30: "IT SHOULD NEVER HAVE 'RE ENTRY' AS A FIELD,
                ONLY REBUYS." The re-entry delta is not a stat this platform
                surfaces; entries vs players plus the Rebuys card says it all. */}
          </div>
        )}

        {showRebuys && (
          <div className="tl-stat">
            <span className="tl-stat__label">Rebuys</span>
            <span className="tl-stat__value">{countText(totals.rebuys)}</span>
          </div>
        )}

        {showAddOns && (
          <div className="tl-stat">
            <span className="tl-stat__label">Add-Ons</span>
            <span className="tl-stat__value">{countText(totals.addOns)}</span>
          </div>
        )}
      </div>

      {/* Said once, plainly, rather than left to be inferred from a row of
          dashes. A refused query is not an empty field. */}
      {detailState === 'unknown' && (showRebuys || showAddOns) && (
        <p className="et-degraded">
          Rebuy And Add-On Counts Could Not Be Loaded. Every Entry Is Still Listed Below.
        </p>
      )}

      {/* Scrolls inside itself. The page keeps exactly one scrollbar and the
          locked footer stays where the player left it. */}
      <ol className="tl-list tl-scroll et-scroll">
        {ordered.map((entry, index) => {
          const detail = details[entry.id];
          const idText = publicId(entry, detail);
          const rebuys = detail?.rebuys ?? entry.rebuys ?? 0;
          const addOn = detail?.addOn || (entry.add_ons ?? 0) > 0;
          const avatarUrl = detail?.avatarUrl || entry.avatar_url;
          const isReentry = reentryIds.has(entry.id);
          const isSatellite = detail?.isSatelliteQualifier || false;

          /* Dan 2026-08-25: "see any player and be redirected to that table
             directly." `table_id` has always been on these rows and was never
             used by them. A player who is still IN, at a table, in a RUNNING
             event, is a route to that table.

             `onWatchPlayer` is absent unless the page says the event is
             running, so a finished event's rows - whose table ids point at
             closed felts - are plain list items, not dead links. */
          const watchable = !!onWatchPlayer && entry.status === 'playing' && !!entry.table_id;

          const body = (
            <>
              {/* Registration ordinal. This is NOT a rank and never moves as
                  the tournament plays out — #3 entered third, forever. */}
              <span className="tl-rank et-ordinal" aria-label={`Entry ${index + 1}`}>
                {`#${(index + 1).toLocaleString()}`}
              </span>

              {avatarUrl ? (
                <img className="tl-avatar" src={avatarUrl} alt="" loading="lazy" />
              ) : (
                <span className="tl-avatar" aria-hidden="true">
                  {initials(entry.username)}
                </span>
              )}

              <span className="et-identity">
                <span className="tl-name">{entry.username}</span>
                {idText && <span className="tl-sub et-id">{idText}</span>}
              </span>

              <span className="et-marks">
                {isSatellite && <SatelliteSeatBadge />}
                {isReentry && (
                  <span className="tl-badge tl-badge--action" title="Re-Entry">
                    RE
                  </span>
                )}
                {showRebuys && rebuys > 0 && (
                  <span className="tl-badge" title={`${rebuys.toLocaleString()} Rebuys`}>
                    {`RB ${rebuys.toLocaleString()}`}
                  </span>
                )}
                {showAddOns && addOn && (
                  <span className="tl-badge tl-badge--good" title="Add-On Taken">
                    AO
                  </span>
                )}
              </span>
            </>
          );

          if (!watchable) {
            return (
              <li key={entry.id} className="tl-row et-row">
                {body}
              </li>
            );
          }

          return (
            <li key={entry.id} className="et-item">
              <button
                type="button"
                className="tl-row tl-row--interactive et-row et-row--watch"
                onClick={() => onWatchPlayer?.(entry.table_id as string)}
                aria-label={`Watch ${entry.username} At Their Table`}
              >
                {body}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
