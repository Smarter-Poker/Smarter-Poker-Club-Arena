/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  IS THIS REPLAYED HAND STILL HUNTABLE? (P5, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 2026-09-05 competitive research found one thing ClubWPT Gold does that
 * we did not: rabbit hunting from the hand replayer, so missing the window at
 * the felt is not final. Ours is a 2250-2650ms window; the server holds the
 * offer for ninety seconds. Everything between those two numbers was time a
 * player could not use.
 *
 * THIS FILE DOES NOT DECIDE WHETHER THE HAND CAN BE BOUGHT. The engine does
 * (`revealRabbitHunt`), and it checks more than a replayed record can know:
 * the offer's existence, its TTL, the table's `allow_rabbit_hunt`, whether
 * the caller was dealt in, and whether they already paid. A second copy of
 * those rules on the client would be a second authority, and the two would
 * drift the first time either moved.
 *
 * What it decides is narrower and purely cosmetic: whether to OFFER the
 * button at all, so the replayer does not show a dead control on the
 * thousands of hands that are plainly past selling. It answers no when the
 * board already ran out (there is nothing unseen), when the hand ran more
 * than one board (Run It Twice and bomb pots are not sold - the engine
 * refuses them too), and when the hand is older than the server's own TTL.
 *
 * When it answers yes and the engine still says no, the engine's own sentence
 * is what the player sees. That is the right way round.
 */

/**
 * The server's `RABBIT_HUNT_OFFER_TTL_MS` (ServerTableEngineSettlement.ts).
 * Copied, not imported: the engine builds from its own rootDir and cannot
 * share a module with the app. `tests/unit/rabbitHuntFromTheReplayer.test.ts`
 * pins the two equal so they cannot drift apart in silence.
 */
export const RABBIT_HUNT_OFFER_TTL_MS = 90_000;

export interface ReplayRabbitCandidate {
  /** hand_number, the key the engine files its offer under. */
  readonly handNumber: number;
  /** When the hand was recorded. Close enough to settlement for a 90s window. */
  readonly timestamp: number;
  /** Community cards on each board this hand ran. */
  readonly boards: ReadonlyArray<ReadonlyArray<unknown>>;
}

export interface ReplayRabbitOffer {
  readonly show: boolean;
  /** How many cards the engine would sell; 0 when there is nothing to sell. */
  readonly cardsUnseen: number;
  /** Milliseconds of the server's window still left, floored at 0. */
  readonly msLeft: number;
}

export function replayRabbitOffer(
  hand: ReplayRabbitCandidate | null | undefined,
  now = Date.now()
): ReplayRabbitOffer {
  const none = { show: false, cardsUnseen: 0, msLeft: 0 } as const;
  if (!hand) return none;

  // More than one board is a re-run or a bomb pot. The engine does not sell
  // either - on a multi-run hand the shared prefix reads as a short board and
  // the "unseen" cards would be deck noise.
  const dealt = hand.boards.filter((b) => b.length > 0);
  if (dealt.length > 1) return none;

  const boardLength = dealt[0]?.length ?? 0;
  const cardsUnseen = Math.max(0, 5 - boardLength);
  // A board that ran out has nothing unseen behind it.
  if (cardsUnseen === 0) return none;

  const age = now - hand.timestamp;
  const msLeft = Math.max(0, RABBIT_HUNT_OFFER_TTL_MS - age);
  // A clock skewed into the future is not a reason to hide the button; the
  // engine will refuse if it is genuinely too old.
  if (age > RABBIT_HUNT_OFFER_TTL_MS) return { show: false, cardsUnseen, msLeft: 0 };

  return { show: true, cardsUnseen, msLeft };
}
