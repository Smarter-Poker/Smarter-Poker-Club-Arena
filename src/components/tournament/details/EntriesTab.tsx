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
 * The owning TournamentDetails page already reads the complete field, including
 * profiles, registration order, rebuys, add-ons and satellite qualification.
 * Its named tournament events and reconnect recovery supply fresh props here.
 * A second capped/polling query used to override those updates with stale data.
 */

import { useMemo } from 'react';
import type { TournamentTabProps, TournamentEntry } from './types';
import { initials } from './types';
import SatelliteSeatBadge from './SatelliteSeatBadge';
import BuyInMarks from './BuyInMarks';
import '../../../styles/tournament-lobby-3d.css';
import './EntriesTab.css';

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
function publicId(entry: TournamentEntry): string | null {
  const code = entry.player_code;
  if (code) return `No. ${code}`;
  if (entry.user_id) return entry.user_id.slice(0, 8).toUpperCase();
  return null;
}

export default function EntriesTab({
  tournament,
  entries,
  currentUserId,
  onWatchPlayer,
}: TournamentTabProps) {
  const rules = (tournament ?? {}) as unknown as EntryRules;

  /**
   * Registration order, strictly ascending.
   *
   * Rows that carry a timestamp sort by it. Rows that do not, such as legacy rows,
   * sort AFTER them, holding the
   * order the page gave us (which is itself `.order('registered_at')`) and
   * falling back to id only to break a genuine tie. The list therefore never
   * jumbles: it either knows the times or it trusts the order it was handed.
   */
  const ordered = useMemo(() => {
    const withIndex = entries.map((entry, index) => {
      const stamp = entry.created_at ?? null;
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
  }, [entries]);

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
      rebuys += entry.rebuys ?? 0;
      if ((entry.add_ons ?? 0) > 0) addOns += 1;
    }
    return {
      rebuys,
      addOns,
      uniquePlayers: new Set(ordered.map((e) => e.user_id).filter(Boolean)).size,
    };
  }, [ordered]);

  /* Columns appear because the event uses them, or because the data already
     proves it did. A column of zeros tells a player nothing except that we
     could not decide whether to show it. */
  const showRebuys = rules.is_rebuy === true || totals.rebuys > 0;
  const showAddOns = rules.add_on_available === true || totals.addOns > 0;
  const showUnique = rules.is_reentry === true || totals.uniquePlayers !== ordered.length;

  // Missing metadata remains unknown; a legacy caller cannot invent a zero.
  const rebuysKnown = ordered.every((entry) => Number.isFinite(entry.rebuys));
  const addOnsKnown = ordered.every((entry) => Number.isFinite(entry.add_ons));
  const countsUnknown = (showRebuys && !rebuysKnown) || (showAddOns && !addOnsKnown);
  const countText = (n: number, known: boolean) => (known ? n.toLocaleString() : '-');

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
            <span className="tl-stat__value">{countText(totals.rebuys, rebuysKnown)}</span>
          </div>
        )}

        {showAddOns && (
          <div className="tl-stat">
            <span className="tl-stat__label">Add-Ons</span>
            <span className="tl-stat__value">{countText(totals.addOns, addOnsKnown)}</span>
          </div>
        )}
      </div>

      {/* Said once, plainly, rather than left to be inferred from a row of
          dashes. Missing entry metadata is not a zero count. */}
      {countsUnknown && (
        <p className="et-degraded">
          Rebuy And Add-On Counts Could Not Be Loaded. Every Entry Is Still Listed Below.
        </p>
      )}

      {/* Scrolls inside itself. The page keeps exactly one scrollbar and the
          locked footer stays where the player left it. */}
      <ol className="tl-list tl-scroll et-scroll">
        {ordered.map((entry, index) => {
          const idText = publicId(entry);
          const rebuys = entry.rebuys ?? 0;
          const addOn = (entry.add_ons ?? 0) > 0;
          const avatarUrl = entry.avatar_url;
          const isReentry = reentryIds.has(entry.id);
          const isSatellite = entry.is_satellite_qualifier ?? false;
          /* YOUR OWN ROW (2026-10-04 review pass). Ranking has always lit the
             signed-in player's row; the register did not, so finding yourself
             in a field of several hundred meant reading every name. */
          const isHero = !!currentUserId && entry.user_id === currentUserId;

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
                {isHero && <span className="tl-badge tl-badge--action">You</span>}
                {isSatellite && <SatelliteSeatBadge />}
                {isReentry && (
                  <span className="tl-badge tl-badge--action" title="Re-Entry">
                    RE
                  </span>
                )}
                {/* Dan 2026-10-24: how many times they rebought and whether
                    they added on, in words - the same marks Ranking carries. */}
                <BuyInMarks rebuys={showRebuys ? rebuys : 0} addOn={showAddOns && addOn} />
              </span>
            </>
          );

          if (!watchable) {
            return (
              <li key={entry.id} className={`tl-row et-row${isHero ? ' tl-row--hero' : ''}`}>
                {body}
              </li>
            );
          }

          return (
            <li key={entry.id} className="et-item">
              <button
                type="button"
                className={`tl-row tl-row--interactive et-row et-row--watch${
                  isHero ? ' tl-row--hero' : ''
                }`}
                onClick={() =>
                  onWatchPlayer?.(entry.table_id as string, undefined, {
                    tournamentId: tournament.id,
                    userId: entry.user_id,
                    username: entry.username,
                  })
                }
                aria-label={isHero ? 'Go To Your Table' : `Watch ${entry.username} At Their Table`}
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
