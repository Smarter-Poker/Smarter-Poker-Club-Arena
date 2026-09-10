/**
 * The shape of an id this platform stores in a uuid column.
 *
 * NOT RFC-4122. Postgres's uuid type accepts any 32 hex digits in the
 * 8-4-4-4-12 layout and never checks the version or variant nibbles, and
 * 62 of the 1,000 horses carry ids minted before the fleet used
 * gen_random_uuid(): 00000000-0000-0000-0000-0000000000NN and
 * face0000-0000-0000-0000-0000000000NN. Those horses have played since
 * February. They are players (CLAUDE.md 10.5), the database seats them,
 * pays them and settles them exactly like every other row.
 *
 * On 2026-09-08/09 a stricter regex - /[1-5][0-9a-f]{3}-[89ab]/ in the third
 * and fourth groups - was written into the tournament launch path and then
 * into the atomic seat-assignment verifier. The database committed each
 * legacy horse's seat and returned ok:true; the engine read the committed
 * receipt as "invalid", called the outcome unknown, aborted the launch, and
 * the event stayed REGISTERING for a day with hundreds of players parked on
 * felt that never dealt. Nineteen Midway Union and Deep Stack Society MTTs
 * were stuck this way at once, holding 881 live seats, and every club card
 * counted those seats as ACTIVE.
 *
 * So: one definition, the database's definition, and nothing in the
 * tournament path validates a player id any more tightly than the column
 * that stores it. Pinned by aLegacyHorseIdIsStillAPlayer.law.test.ts.
 */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/** The value when it is uuid-shaped, otherwise null. */
export function uuidShape(value: unknown): string | null {
  return isUuidShape(value) ? value : null;
}
