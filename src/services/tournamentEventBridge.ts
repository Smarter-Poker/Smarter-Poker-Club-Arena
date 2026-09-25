/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT EVENT BRIDGE — the server's break broadcasts, onto MasterBus
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, on finding these logged as known-dead rather than fixed:
 * "WHY WOULD YOU LEAVE THIS INSTEAD OF FIXING IT?!"
 *
 * He was right. There was no product decision outstanding — the handlers had
 * already been written and already said exactly what each event shows:
 *
 *   TournamentClock       flips isBreak, seeds breakTimeRemaining from
 *                         durationMinutes, and refreshes on resume.
 *   TournamentDetails     toasts "Tournament break - play resumes shortly"
 *                         and "Break over - play resuming".
 *
 * They simply never ran. TournamentManagerBase DOES broadcast the breaks — on
 * the supabase channel `t-break-<id>`, event `tournament_event`, shaped
 * `{ type, payload }` — but nothing ever put those onto MasterBus, which is
 * what both components subscribe to. Three separate pages each subscribed to
 * that channel and each wrote their own switch; none of them relayed.
 *
 * So this is the relay, in one place rather than a fourth copy of the switch.
 * Every consumer of the channel calls it, and the mapping lives here.
 *
 * NAME MAPPING. The bus carries two spellings of the same thing because two
 * components picked different ones (TournamentClock listens for both). Emitting
 * both is deliberate: it is two cheap events rather than a rename that would
 * have to land in four files at once to avoid breaking a listener.
 */
import { masterBus } from '../core/MasterBus';

/** The raw `{ type, payload }` a `tournament_event` broadcast carries. */
export interface TournamentEventEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Emitting the same break twice would double-toast. `getOrCreateChannel` hands
 * every page the SAME channel object, so N mounted pages calling this add N
 * listeners to one subscription and each broadcast arrives N times. Keyed on
 * the event identity rather than a timer so a genuine second break is never
 * swallowed.
 */
const recent = new Map<string, number>();
const DEDUPE_MS = 1500;

function seenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

/**
 * Relay one `tournament_event` broadcast onto MasterBus.
 *
 * Safe to call from every consumer of the channel; unknown types are ignored,
 * so adding a server event does not require touching this first.
 */
export function relayTournamentEvent(
  tournamentId: string,
  envelope: TournamentEventEnvelope | null | undefined
): void {
  const type = envelope?.type;
  if (!type || !tournamentId) return;
  const data = (envelope?.payload ?? {}) as Record<string, unknown>;

  /* The emits below are written as LITERALS, never `emit(someVariable, ...)`.
     tests/unit/noDeadBusSubscriptions.test.ts finds publishers by scanning for
     `masterBus.emit('NAME'`, so a dynamic emit is invisible to it and the
     event it publishes still counts as dead. Keeping them literal is what lets
     that guard see this file at all. */
  const freshFor = (discriminator: string | number | undefined | null) =>
    !seenRecently(`${tournamentId}:${type}:${discriminator ?? ''}`);
  const fresh = (payload: Record<string, unknown>) =>
    freshFor(payload.level as string | number | undefined);

  switch (type) {
    // Break begins. `tournament_break` carries the duration; the countdown
    // variant carries only an end time, so derive minutes from it rather than
    // letting TournamentClock fall back to its hardcoded 300 seconds.
    case 'tournament_break':
    case 'tournament_break_started': {
      const endsAtRaw = data.breakEndsAt;
      const endsAt = typeof endsAtRaw === 'string' ? Date.parse(endsAtRaw) : NaN;
      const durationMinutes =
        typeof data.breakDurationMinutes === 'number'
          ? data.breakDurationMinutes
          : Number.isFinite(endsAt)
            ? Math.max(1, Math.round((endsAt - Date.now()) / 60000))
            : undefined;

      const startPayload = {
        tournamentId,
        durationMinutes,
        breakEndsAt: typeof endsAtRaw === 'string' ? endsAtRaw : undefined,
        level: data.level,
        nextLevel: data.nextLevel,
      };
      if (fresh(startPayload)) {
        masterBus.emit('TOURNAMENT_BREAK', startPayload as never);
        masterBus.emit('BREAK_START', startPayload as never);
      }
      break;
    }

    case 'break_ended': {
      const endPayload = { tournamentId, level: data.level };
      if (fresh(endPayload)) {
        masterBus.emit('TOURNAMENT_BREAK_END', endPayload as never);
        masterBus.emit('BREAK_END', endPayload as never);
      }
      break;
    }

    /**
     * THE BLIND LEVEL, AT LAST WITH A PRODUCER.
     *
     * `BLIND_LEVEL_CHANGE` had exactly one emitter in the whole client:
     * TournamentTimerService.handleLevelChange. That service's own resolution
     * note records that `initializeAllTimers` "has been deleted outright, and
     * nothing in src/ calls startTimer()", so handleLevelChange never runs and
     * the event was never published. TournamentClock, BlindsTab and
     * TournamentDetails have all subscribed to it the whole time and received
     * nothing - and the `tournaments` postgres_changes subscriptions that were
     * the other route are unpublished (5,477,895 writes over 117 columns).
     *
     * The engine has been broadcasting the level all along, on this very
     * channel. Relaying it here gives the event a real, cross-client producer
     * for the first time, with no publication change and no new server work.
     *
     * THE +1 IS THE WHOLE RISK, so it is written down. The server sends
     * `level: this.currentLevel`, and that is a ZERO-BASED ARRAY INDEX: it is
     * initialised to 0, loaded straight from `tournaments.current_level`, and
     * passed to `resolveBlindLevel(blindStructure, index)` which returns
     * `blindStructure[i]`. `BLIND_LEVEL_CHANGE` consumers expect the DISPLAY
     * level instead - TournamentClock renders `payload.level` raw as
     * "LEVEL {n}" and its comment states outright "THE PAYLOAD IS ALREADY THE
     * DISPLAY LEVEL", because the dead emitter sent `newLevel + 1`.
     *
     * Getting this wrong has already shipped twice, in both directions: once a
     * clock that flashed one level BACKWARDS, then a correction that made it
     * flash one level FORWARD, "LEVEL 6 -> LEVEL 7 on the projector in front of
     * the room". Index plus one, once, here.
     */
    case 'level_up': {
      /* `Number(null)` is 0, not NaN, so a bare Number() cast would have turned
         a missing level into index 0 and published "LEVEL 1" as though the
         tournament had restarted. Accept a real number, or a non-empty numeric
         string, and nothing else. */
      const rawLevel = data.level;
      const rawIndex =
        typeof rawLevel === 'number'
          ? rawLevel
          : typeof rawLevel === 'string' && rawLevel.trim() !== ''
            ? Number(rawLevel)
            : NaN;
      if (!Number.isFinite(rawIndex)) break;
      const displayLevel = Math.max(1, Math.floor(rawIndex) + 1);
      const levelPayload = {
        tournamentId,
        level: displayLevel,
        smallBlind: data.smallBlind,
        bigBlind: data.bigBlind,
        ante: data.ante,
      };
      if (freshFor(displayLevel)) {
        masterBus.emit('BLIND_LEVEL_CHANGE', levelPayload as never);
        /* The dead emitter published this alongside, in the same shape, for the
           page-level listeners that only need "something moved". */
        masterBus.emit('TOURNAMENT_UPDATED', {
          tournamentId,
          status: `blind_level_${displayLevel}`,
        } as never);
      }
      break;
    }

    /**
     * ELIMINATIONS, WITHOUT NEEDING THE FELT MOUNTED.
     *
     * `PLAYER_ELIMINATED`'s only emitter is TablePage's own copy of this
     * switch, so RankingTab, TournamentDetails and TournamentLobbyPage only
     * learned about a bust when the player happened to have the table open in
     * the same tab. Relaying here means any page joined to this channel feeds
     * all of them.
     *
     * The field rename is deliberate, not a typo: the server sends
     * `playerName`, and TablePage's emit reads `elimData.username`, so the name
     * has always arrived empty there. Both are accepted, server spelling first.
     */
    case 'player_eliminated': {
      const userId = String(data.userId ?? '');
      /* No player, no elimination. An empty id would publish a bust that every
         consumer then fails to match against any row, which is worse than the
         silence it replaces. */
      if (!userId) break;
      const position = Number(data.position) || 0;
      /* Keyed on who and where, NOT on level: `fresh` keys on payload.level,
         which is absent here, so two players busting within the dedupe window
         would have collapsed into one event and one of them would vanish. */
      if (!freshFor(`${userId}:${position}`)) break;
      masterBus.emit('PLAYER_ELIMINATED', {
        tournamentId,
        userId,
        position,
        prize: Number(data.prize) || 0,
        username: String(data.playerName ?? data.username ?? ''),
      } as never);
      break;
    }

    /**
     * THE REST OF WHAT A SEATED PLAYER'S HUD HAS TO HEAR (2026-09-22).
     *
     * The engine broadcasts four more facts on this channel that nothing
     * relayed, so the only way to hear them was to bind the channel yourself.
     * That is how TournamentHUD came to hold its own `.on('broadcast')` on a
     * channel TablePage was already holding - and a Realtime binding cannot be
     * removed on its own, so while TablePage kept the channel every remount of
     * the HUD left one more live listener behind, each still firing reads.
     *
     *   late_reg_closed     the entry window shut; the prize pool is changing
     *   ADDON_PERIOD_START  the persisted add-on window opened, so the row now
     *                       carries addon_period_started_at / _ends_at
     *   bubble_burst        hand-for-hand is over; carries playersRemaining
     *   final_table         the field fits one table; carries playerCount
     *
     * They ride TOURNAMENT_UPDATED, the bus's existing "this tournament moved"
     * event that level_up already publishes above, with the engine's event
     * named in `status` - the same shape as `blind_level_<n>`. Every
     * TOURNAMENT_UPDATED listener already reads it as "re-read if you care",
     * which is what all four mean.
     *
     * FINAL_TABLE_REACHED is deliberately NOT emitted for final_table.
     * FinalTableOverlay listens for it, and TablePage publishes it itself, for
     * MTTs only, with the seated field. A second copy from here would give a
     * three-handed Spin a final-table celebration on its first hand, which is
     * precisely what TablePage suppresses.
     */
    case 'late_reg_closed': {
      if (freshFor('')) {
        masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: 'late_reg_closed' });
      }
      break;
    }

    case 'ADDON_PERIOD_START': {
      // A thaw can move the window and re-announce it; that one is new.
      const endsAt = typeof data.endsAt === 'string' ? data.endsAt : '';
      if (freshFor(endsAt)) {
        masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: 'addon_period_start' });
      }
      break;
    }

    case 'bubble_burst': {
      /* A count, or nothing. `Number(null)` is 0, and "0 players left" is a
         claim the engine never made. */
      const raw = data.playersRemaining;
      const playersRemaining =
        typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
      const burst = { tournamentId, status: 'bubble_burst', playersRemaining };
      if (freshFor(playersRemaining)) masterBus.emit('TOURNAMENT_UPDATED', burst);
      break;
    }

    case 'final_table': {
      const count = typeof data.playerCount === 'number' ? data.playerCount : undefined;
      if (freshFor(count)) {
        masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: 'final_table' });
      }
      break;
    }

    default:
      // Not a break event. Every page keeps its own switch for the rest.
      break;
  }
}
