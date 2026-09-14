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
 *   TournamentClock       flips isBreak, seeds breakTimeRemaining from the
 *                         break's END TIME (durationMinutes only when no end
 *                         travelled), and refreshes on resume.
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
  const fresh = (payload: Record<string, unknown>) =>
    !seenRecently(`${tournamentId}:${type}:${payload.level ?? ''}`);

  switch (type) {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A BREAK IS TWO EVENTS, AND ONLY THE SECOND ONE HAS A CLOCK (2026-09-09)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The engine sends `tournament_break` at :55 with
     * `phase: 'last_hand'`, `breakEndsAt: null` and `breakDurationMinutes: 5`
     * (TournamentManagerBase.ts:1510-1523), and `tournament_break_started`
     * with the REAL end time once the last hand has landed on every table
     * (:1611-1619). The end time was deliberately REMOVED from the first event
     * on 2026-08-27 (:1494-1508) because clients counting down to :55 plus five
     * minutes reached 0:00 up to LAST_HAND_GRACE_MS (two minutes) before play
     * resumed, and then sat at zero under a full-screen opaque overlay.
     *
     * This relay handed `durationMinutes: 5` straight through on BOTH events,
     * and both lobby consumers turn a bare duration into exactly the instant
     * the server stopped sending: TournamentClock.tsx:378-384 and
     * BlindsTab.tsx:210-213 both fall back to `Date.now() + minutes * 60_000`.
     * So the fabricated end was reconstructed here, one layer down, and the
     * player watched a 5:00 countdown start at :55 and then jump back up to
     * 5:00 when the real end arrived up to two minutes later. On the Blinds tab
     * it was worse than a jump: that handler keeps the FIRST answer it is
     * given, so the invented instant won for the whole break.
     *
     * `durationMinutes` is a COUNTDOWN SEED, so only a countdown may carry one.
     * The last-hand announcement forwards `phase` and no seed at all, which is
     * what lets a client render "Last Hand" instead of a wrong number - the
     * same rule TablePage.tsx:12959 already applies to the table's own copy of
     * this broadcast.
     */
    case 'tournament_break':
    case 'tournament_break_started': {
      const endsAtRaw = data.breakEndsAt;
      const endsAt = typeof endsAtRaw === 'string' ? Date.parse(endsAtRaw) : NaN;
      const hasEnd = Number.isFinite(endsAt);

      const phase: 'last_hand' | 'counting_down' =
        data.phase === 'last_hand' || data.phase === 'counting_down'
          ? (data.phase as 'last_hand' | 'counting_down')
          : hasEnd || type === 'tournament_break_started'
            ? 'counting_down'
            : 'last_hand';

      // A real end time always wins. A seed is offered only once the countdown
      // has genuinely started; during the last hand there is nothing to count.
      const durationMinutes =
        phase === 'last_hand' && !hasEnd
          ? undefined
          : typeof data.breakDurationMinutes === 'number'
            ? data.breakDurationMinutes
            : hasEnd
              ? Math.max(1, Math.round((endsAt - Date.now()) / 60000))
              : undefined;

      const startPayload = {
        tournamentId,
        phase,
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

    /**
     * THE TABLE BREAK WARNING (2026-09-09).
     *
     * `TABLE_BREAK_WARNING` has been declared in MasterBus's event union and its
     * payload map since the TableBreakEngine port, and NOTHING HAS EVER EMITTED
     * IT - that engine is constructed per table and no method on it is ever
     * called, so its whole warning/started/moved/completed sequence is dead.
     * TournamentManager.checkTableBalance now announces the break itself, 30
     * seconds before it moves anybody, and this is where that announcement
     * becomes the bus event the declaration always promised.
     *
     * Deduped on the TABLE rather than on `level`, which a break warning does
     * not carry: two tables breaking within the dedupe window are two different
     * warnings and both must be delivered.
     */
    case 'table_break_warning': {
      const tableId = typeof data.tableId === 'string' ? data.tableId : '';
      if (seenRecently(`${tournamentId}:${type}:${tableId}`)) break;
      masterBus.emit('TABLE_BREAK_WARNING', {
        tableId,
        tournamentId,
        secondsRemaining: Number(data.secondsRemaining) || 0,
        playerCount: Number(data.playerCount) || 0,
        // Not in MasterBus's declared payload for this event; see the note in
        // the PR. A client uses it to say "this is you" rather than announcing
        // somebody else's table break to the whole field.
        playerIds: Array.isArray(data.playerIds) ? (data.playerIds as string[]) : [],
      } as never);
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

    default:
      // Not a break event. Every page keeps its own switch for the rest.
      break;
  }
}
