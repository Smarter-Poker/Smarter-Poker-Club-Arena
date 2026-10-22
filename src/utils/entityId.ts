/**
 * A DATABASE ID IS A UUID, NOT A UUID OF A PARTICULAR VERSION (2026-10-21).
 *
 * Postgres accepts any 8-4-4-4-12 hex value into a `uuid` column, and real
 * production rows use ids that are not RFC version 1-5:
 *   - the Midway Union and its house club: fade0000-0000-0000-0000-000000000001
 *   - The Felt Society:                     a0000000-0000-0000-0000-000000000001
 *   - horses and early accounts:            00000000-0000-0000-0000-0000000000NN
 * A regex that pins the version and variant nibbles
 * (`[1-5][0-9a-f]{3}-[89ab]`) refuses every one of them. On 2026-10-21 it
 * refused every Union Bank pull back ("Invalid Union Wallet Intent"), and it
 * refused every agent wallet transfer in The Felt Society and every transfer
 * to a horse ("The Transfer Account Could Not Be Verified").
 *
 * Validate ids READ FROM THE DATABASE (users, clubs, unions, recipients) with
 * this shape check. Ids the CLIENT GENERATES for itself (operation and request
 * ids from crypto.randomUUID) may keep a strict version check; they are always
 * v4. The nil uuid is never a real entity.
 *
 * The SQL twin of this rule is tests/a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts.
 */
export const ENTITY_ID_PATTERN =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID_PATTERN.test(value);
}
