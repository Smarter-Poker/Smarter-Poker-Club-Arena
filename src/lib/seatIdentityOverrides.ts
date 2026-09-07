/**
 * SEAT IDENTITY OVERRIDES - a newer face is never repainted with an older one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07: "WHEN A USER CHANGES THEIR AVATAR, IT BOUNCES BACK AND
 * FORTH FROM THEIR OLD AVATAR TO THE NEW ONE. IT NEEDS TO CHANGE AND STAY
 * ACROSS ALL GAMES AND TABLES REGARDLESS OF DEVICE AS WELL."
 *
 * THE BOUNCE, MECHANICALLY
 *
 * Two readers of the SAME column (`profiles.arena_avatar_url`, see
 * `./tableAvatar.ts`) sample it at different times:
 *
 *   - The engine reads the seated roster once, at the top of each hand
 *     (`loadSeatedPlayers`), copies the identity fields onto the hand's
 *     players, and republishes them on EVERY broadcast for the rest of that
 *     hand - each action, each street, each timer tick.
 *   - `useSeatedProfileSync` receives the UPDATE the moment the row changes
 *     (postgres_changes, the BroadcastChannel-backed picker event, and a
 *     reconcile read whenever its channel comes live).
 *
 * The client merged both into the same `tableState.players[i].avatar`, with
 * whichever arrived last winning. So: the picker paints the new face; the
 * next engine broadcast paints the old one back; the realtime echo paints
 * the new one; the next action paints the old one... until the next hand,
 * when the engine re-reads `profiles` and the two agree. Every viewer at the
 * table saw it, on every device, because every viewer runs both readers.
 *
 * THE RULE
 *
 * The engine is authoritative for the HAND: stacks, cards, status, seats,
 * turn. The database is authoritative for IDENTITY, and the engine's copy
 * of identity is a cache taken at deal time. A profile change delivered by
 * the database is therefore at least as new as anything the engine holds,
 * and an engine broadcast may not repaint over it. The engine wins again the
 * moment it proves it has re-read the row - which it does by publishing an
 * identity DIFFERENT from the one it was publishing when the override was
 * taken. Any movement in the engine's identity for a seat is a re-read of
 * `profiles` (nothing else changes those three fields), and a re-read is by
 * definition newer than the override, so the override is dropped and the
 * engine's value adopted, whatever it is.
 *
 * That last clause is what keeps this a resolution rule and not a cache: an
 * override never outlives the engine's next look at the row, so a change the
 * client missed (a phone asleep through the realtime event) is still
 * corrected by the engine one hand later, exactly as today.
 *
 * WHAT THIS IS NOT
 *
 * Not a device-local store. Nothing here is persisted; an override is born
 * from a database event and dies at the engine's next re-read or the
 * player's departure. A cache may pre-warm a face (`cachedIdentity.ts`
 * does); it may never override the server, and neither does this.
 *
 * ANONYMOUS TABLES
 *
 * The engine scrubs identity uniformly at an anonymous table
 * (`seatIdentity` in ServerTableEngine). A real face must not be painted
 * over that scrub, so the page hands this module nothing at those tables:
 * the profile sync is not subscribed and `apply` is bypassed. That is the
 * caller's gate, kept beside the subscription it gates.
 */

export interface SeatIdentity {
  avatar?: string;
  frame?: string;
  aura?: string;
}

/** The shape `useSeatedProfileSync` delivers. `null` means "explicitly none". */
export interface SeatIdentityChange {
  userId: string;
  avatar?: string;
  frame?: string | null;
  aura?: string | null;
}

interface SeatLike {
  id: string;
  avatar?: string;
  frame?: string;
  aura?: string;
}

interface Override {
  identity: SeatIdentity;
  /**
   * The identity the engine was publishing for this player when the override
   * was taken. `undefined` when no engine frame had arrived yet; the first
   * frame then becomes the baseline (and drops the override at once if it
   * already agrees).
   */
  engineSaw: SeatIdentity | undefined;
}

function identityOf(p: SeatLike): SeatIdentity {
  return { avatar: p.avatar, frame: p.frame, aura: p.aura };
}

function sameIdentity(a: SeatIdentity | undefined, b: SeatIdentity | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    (a.avatar || '') === (b.avatar || '') &&
    (a.frame || '') === (b.frame || '') &&
    (a.aura || '') === (b.aura || '')
  );
}

/**
 * Merge a change onto an existing identity with the sync's field semantics:
 * `undefined` = the event did not mention the field, keep it; `null` = the
 * player explicitly removed it. Exported so the page and the tests share one
 * definition of "what does this change mean".
 */
export function mergeSeatIdentity(
  existing: SeatIdentity | undefined,
  change: SeatIdentityChange
): SeatIdentity {
  return {
    avatar: change.avatar ?? existing?.avatar,
    frame: change.frame === undefined ? existing?.frame : (change.frame ?? undefined),
    aura: change.aura === undefined ? existing?.aura : (change.aura ?? undefined),
  };
}

export interface SeatIdentityOverrides {
  /**
   * Record a database-sourced identity change. `existing` is the identity the
   * seat currently shows (engine value or a previous override). Returns the
   * identity to paint now.
   */
  record(change: SeatIdentityChange, existing: SeatIdentity | undefined): SeatIdentity;
  /**
   * Apply to a freshly mapped engine roster. Notes what the engine is now
   * publishing for every seat, drops every override the engine has caught up
   * with, applies the survivors, and forgets players no longer seated. Never
   * touches anything but the three identity fields.
   */
  apply<T extends SeatLike | null>(players: readonly T[]): T[];
  /** How many players currently carry an override (for tests and telemetry). */
  size(): number;
  /** Forget everything - table change, unmount. */
  clear(): void;
}

export function createSeatIdentityOverrides(): SeatIdentityOverrides {
  const overrides = new Map<string, Override>();
  const engineSeen = new Map<string, SeatIdentity>();

  return {
    record(change, existing) {
      const identity = mergeSeatIdentity(existing, change);
      const engineSaw = engineSeen.get(change.userId);
      // The engine already publishes exactly this. Nothing to hold.
      if (engineSaw && sameIdentity(engineSaw, identity)) {
        overrides.delete(change.userId);
        return identity;
      }
      overrides.set(change.userId, { identity, engineSaw });
      return identity;
    },

    apply<T extends SeatLike | null>(players: readonly T[]): T[] {
      const seated = new Set<string>();
      const out = players.map((p): T => {
        if (!p) return p;
        seated.add(p.id);
        const engineNow = identityOf(p);
        engineSeen.set(p.id, engineNow);
        const override = overrides.get(p.id);
        if (!override) return p;
        if (override.engineSaw === undefined) {
          // First engine frame since the change: it becomes the baseline. If
          // it already agrees with the override, the override has done its
          // job.
          if (sameIdentity(engineNow, override.identity)) {
            overrides.delete(p.id);
            return p;
          }
          override.engineSaw = engineNow;
        } else if (!sameIdentity(engineNow, override.engineSaw)) {
          // The engine re-read `profiles` (nothing else moves these fields).
          // That read is newer than the override: adopt it, whatever it says.
          overrides.delete(p.id);
          return p;
        }
        return { ...p, ...override.identity } as T;
      });
      for (const id of Array.from(overrides.keys())) if (!seated.has(id)) overrides.delete(id);
      for (const id of Array.from(engineSeen.keys())) if (!seated.has(id)) engineSeen.delete(id);
      return out;
    },

    size() {
      return overrides.size;
    },

    clear() {
      overrides.clear();
      engineSeen.clear();
    },
  };
}
