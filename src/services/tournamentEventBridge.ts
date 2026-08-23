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
  const fresh = (payload: Record<string, unknown>) =>
    !seenRecently(`${tournamentId}:${type}:${payload.level ?? ''}`);

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

    default:
      // Not a break event. Every page keeps its own switch for the rest.
      break;
  }
}
