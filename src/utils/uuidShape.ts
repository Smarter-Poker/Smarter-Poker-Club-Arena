/**
 * The shape of an id this platform stores in a uuid column: 32 hex digits in
 * the 8-4-4-4-12 layout. NOT RFC-4122 - Postgres never checks the version or
 * variant nibbles, and 62 of the horses carry ids minted before the fleet
 * used gen_random_uuid() (00000000-0000-0000-0000-0000000000NN,
 * face0000-...). A stricter check refused those players; see
 * docs/changelog/2026-09-09-a-legacy-horse-id-is-still-a-player.md. Anything
 * that names a player, a club, a union or an operation validates with this
 * and nothing tighter.
 */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}
