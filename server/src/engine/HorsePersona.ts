/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE PERSONA v2 — what the tuner may never overwrite (V48, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From the deep audit, section 5.6: "Persona is three numbers." Every horse
 * in production carries `style`, `tightness`, `aggression`, `bluffFreq`,
 * `sizingMultiplier`, `lane`, `stakeBand` - and `horse_personality` (100 rows
 * with gto_adherence, risk_tolerance, preferred_game_types, archetype_name)
 * has no reader anywhere.
 *
 * There is a second problem underneath that one, and it is the reason this
 * file exists rather than four more dials. THE NIGHTLY TUNER WRITES THE SAME
 * KEYS AN AUTHOR WRITES. `tightness`, `aggression` and `bluffFreq` are
 * rewritten every night from measured frequencies, so an authored
 * personality is one night away from being averaged into the fleet - and on
 * 2026-09-04 the regression rule halved all three on 221 of 383 horses in a
 * single run.
 *
 * So persona v2 is a SEPARATE, TYPED, BOUNDED namespace under
 * `profiles.horse_profile.persona`:
 *
 *   - written by an author, by onboarding, or by the seeding migration;
 *   - NEVER written by HorseSelfTuner (ThePersonaSurvivesTheTuner.law.test.ts
 *     reads the tuner's source and fails if it ever writes a persona key);
 *   - every field bounded at the read boundary, like the dials, so a bad row
 *     degrades to the default instead of reaching a decision;
 *   - deterministic defaults from the horse id, so a horse with no persona
 *     row is still an individual and the fleet is diverse from first boot.
 *
 * Pure: no imports at all. NEVER refer to the horses as "bots" - they are
 * HORSES only.
 */

/** The authored persona. Every field is a rate or a bounded scalar. */
export interface HorsePersonaV2 {
  /**
   * How often this horse posts a VOLUNTARY straddle at a straddle-enabled
   * table, per hand it is under the gun. 0 = never (the nit), 0.35 = the
   * table's action player. Read by ServerTableEngineDealing before the
   * straddle round.
   */
  straddleRate: number;
  /**
   * How closely this horse follows the solver line when one exists, 0..1.
   * 1 = takes the chart every time; 0.7 = deviates on a third of the spots
   * where its own read disagrees. Read by HorseLogic at the solver consult.
   */
  gtoAdherence: number;
  /**
   * How often this horse takes a breather after a big losing hand, per hand
   * it loses SIT_OUT_LOSS_BB or more (2026-09-06). 0 = the grinder who never
   * stops; 0.25 = the player who pushes back from the table after a cooler.
   *
   * Read by ServerTableEngineSettlement, which sits the seat out through the
   * SAME public sitOut() a human's button calls, and books it back in one
   * orbit later. Cash only - a tournament seat is bought and gets blinded off,
   * so sitting out there is not a breather, it is a leak.
   *
   * It is one of the most visible absences at a live table: the seat that
   * takes a 200bb cooler and is in the very next hand, every single time,
   * forever.
   */
  sitOutAfterLossRate: number;
}

/*
 * WHAT IS DELIBERATELY NOT HERE (2026-09-05).
 *
 * `preferredDepthBB` was drafted and removed in the same session. The buy-in
 * is chosen by HorseFleetManager.seatHorse through HorseBehavior.buyInBBFor,
 * which is given a horse id and nothing else - reading a persona there means
 * a database read inside the seating path for a field no horse has authored
 * yet. A registered field with no reader is precisely the dead data this
 * estate's ledger exists to prevent, so it waits for the seating path to
 * carry the profile it already loads elsewhere.
 *
 * `sitOutAfterLossRate` LANDED on 2026-09-06, and it landed the moment its
 * hook did: ServerTableEngineSeating.sitOut is the same public method a
 * human's Sit Out button calls, and settlement already knows every horse's
 * net for the hand. That is the whole rule this comment is stating - a field
 * goes in WITH its hook, never before it.
 *
 * `tilt` and `showBluffRate` are still out, and for the same reason they
 * always were. `tilt` needs a per-seat session memory that survives hands and
 * nothing in the engine keeps one. `showBluffRate` needs a voluntary
 * show-cards action for a pot won WITHOUT showdown, and the engine has muck
 * handling and an observer setting but no such action - building it is an
 * engine and client change, not a persona one. Shipping either field now
 * would be exactly the dead data the ledger exists to refuse.
 */

export const PERSONA_DEFAULT: HorsePersonaV2 = {
  straddleRate: 0,
  gtoAdherence: 1,
  sitOutAfterLossRate: 0,
};

/**
 * The loss that earns a breather, in big blinds.
 *
 * 100bb is a full buy-in at most tables, which is the size of hand a player
 * actually reacts to. Lower and the fleet would be standing up constantly -
 * `fleet_seat_starvation` already reports 545 of 821 cash seats empty, and a
 * horse in a chair is what fills them.
 */
export const SIT_OUT_LOSS_BB = 100;

/** How long the breather lasts. One orbit at a full table, near enough. */
export const SIT_OUT_MS = 75_000;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Deterministic 32-bit hash with a real avalanche step.
 *
 * NOT the `h * 31 + c` scheme HorseBehavior uses, and the tests are why. That
 * hash barely mixes: `horse-a` and `horse-b` differ in one character and land
 * in the same persona bucket, and hashing `id|straddle|N` over sequential N
 * cycles its low bits, so a rate of 0.3 straddled 66% of hands. Both were
 * caught by the distribution assertions in
 * ThePersonaSurvivesTheTuner.law.test.ts before this ever reached a table.
 *
 * FNV-1a plus the murmur3 finalizer: one character changes every output bit,
 * and consecutive inputs are independent. Still pure and deterministic, which
 * is the only thing the engine requires (Math.random is banned in a decision
 * path, and a replayed hand must answer the same way twice).
 */
function personaHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The persona a horse with no authored row gets: deterministic in its id, so
 * the fleet is diverse without anybody choosing, and stable across deploys.
 *
 * The straddle rate is deliberately skewed: most players never straddle, a
 * few always do. A flat spread would put every seat at the table in the
 * middle, which is the least human distribution there is.
 */
export function defaultPersonaFor(horseId: string): HorsePersonaV2 {
  // One independently mixed hash per field: slices of a single hash share
  // structure, and three fields drawn from one 32-bit value is exactly how
  // two horses end up with the same personality.
  const hs = personaHash(`${horseId}|straddle`);
  const hg = personaHash(`${horseId}|gto`);
  const ho = personaHash(`${horseId}|sitout`);
  const bucket = hs % 100;
  const straddleRate =
    bucket < 60 ? 0 : bucket < 85 ? 0.08 + ((hs >>> 8) % 8) / 100 : 0.25 + ((hs >>> 16) % 15) / 100;
  // Most players sit straight back down; a minority take a walk after a
  // cooler and a few always do. Same shape as the straddle, gentler tail -
  // an empty seat costs the table more than an eager one.
  const outBucket = ho % 100;
  const sitOutRate =
    outBucket < 55
      ? 0
      : outBucket < 88
        ? 0.05 + ((ho >>> 8) % 8) / 100
        : 0.18 + ((ho >>> 16) % 13) / 100;
  return {
    straddleRate: Math.round(straddleRate * 100) / 100,
    // 0.80 .. 1.00 - nobody in the fleet ignores the solver entirely.
    gtoAdherence: Math.round((0.8 + (hg % 21) / 100) * 100) / 100,
    sitOutAfterLossRate: Math.round(sitOutRate * 100) / 100,
  };
}

/**
 * Read a persona out of a `profiles.horse_profile` value. Anything missing,
 * out of range or the wrong type falls back to the deterministic default for
 * that field - the same boundary discipline resolveHorseStyle applies to the
 * dials, and for the same reason: a bad row must degrade, never reach a
 * decision.
 */
/**
 * Does this horse take a breather after THIS losing hand? Deterministic in
 * (horse, hand), exactly like wantsStraddle and for the same two reasons: a
 * replayed hand must answer the same way twice, and a test must be able to
 * assert the distribution rather than hope. Math.random is banned anywhere
 * near a decision.
 */
export function wantsSitOutAfterLoss(horseId: string, handNumber: number, rate: number): boolean {
  if (!(rate > 0)) return false;
  const h = personaHash(`${horseId}|sitout|${handNumber}`);
  return (h % 10_000) / 10_000 < rate;
}

export function resolvePersona(profile: unknown, horseId: string): HorsePersonaV2 {
  if (!profile || typeof profile !== 'object') return defaultPersonaFor(horseId);
  return personaFromValue((profile as Record<string, unknown>).persona, horseId);
}

/**
 * The same read, given the persona VALUE rather than the whole profile.
 * resolveHorseStyle has already unwrapped `horse_profile` by the time it
 * reaches the persona, and reading `obj.persona` there is what makes the
 * ledger's "every registered profile key is parsed at the boundary" test
 * able to see it.
 */
export function personaFromValue(raw: unknown, horseId: string): HorsePersonaV2 {
  const base = defaultPersonaFor(horseId);
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const straddle = num(p.straddleRate);
  const adherence = num(p.gtoAdherence);
  const sitOutRate = num(p.sitOutAfterLossRate);
  return {
    straddleRate: straddle === undefined ? base.straddleRate : clamp(straddle, 0, 0.6),
    gtoAdherence: adherence === undefined ? base.gtoAdherence : clamp(adherence, 0.5, 1),
    // Bounded hard at 0.35. A horse that sits out after every cooler is a
    // horse that is not in the game, and an empty seat is worse for the table
    // than a slightly robotic one.
    sitOutAfterLossRate:
      sitOutRate === undefined ? base.sitOutAfterLossRate : clamp(sitOutRate, 0, 0.35),
  };
}

/**
 * Does this horse straddle THIS hand? Deterministic in (horse, hand): a
 * replayed hand must answer the same way twice, `Math.random` is banned in
 * the engine's decision paths, and a test must be able to assert the
 * distribution. The hand number is the only thing that moves.
 */
export function wantsStraddle(horseId: string, handNumber: number, rate: number): boolean {
  if (!(rate > 0)) return false;
  const h = personaHash(`${horseId}|straddle|${Math.max(0, Math.floor(handNumber))}`);
  return (h % 1000) / 1000 < Math.min(0.6, rate);
}

/**
 * Does this horse take the solver line here? Deterministic in (horse, hand,
 * spot) for the same reason. `spot` is any stable label for the decision -
 * the street plus the node key - so one hand can deviate on the flop and
 * follow the chart on the turn, which is what a person does.
 */
export function followsSolver(
  horseId: string,
  handNumber: number,
  spot: string,
  adherence: number
): boolean {
  if (adherence >= 1) return true;
  const h = personaHash(`${horseId}|gto|${Math.max(0, Math.floor(handNumber))}|${spot}`);
  return (h % 1000) / 1000 < Math.max(0, Math.min(1, adherence));
}
