/**
 * AN ABANDONED FIRST HAND OF AN EVENT THAT NEVER DEALT IS A MISDEAL (2026-10-03)
 *
 * Heads-up SNG b290375a: a dead generation wrote both hole cards of the
 * event's FIRST hand and died before its snapshot. The abandoned-generation
 * door voids such a hand only when every chair provably holds what it held
 * before the hand - and it proved that ONLY against the table's last
 * committed hand. A first hand has none, so the door refused
 * F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT at every ask and two real players sat
 * RUNNING with 0 hands for 6.5 hours. When no hand was ever committed at any
 * table of the event, the only truthful stack is the event's starting chips.
 *
 * docs/changelog/2026-10-03-an-abandoned-first-hand-is-a-misdeal.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const SQL = readFileSync(
  join(
    MIGRATIONS,
    '20261003051223_an_abandoned_first_hand_of_an_event_that_never_dealt_is_a_mi.sql'
  ),
  'utf8'
);
const PRIOR = readFileSync(
  join(
    MIGRATIONS,
    '20260927145416_a_never_started_dead_hand_leaves_its_own_premanifest_park_to.sql'
  ),
  'utf8'
);

const DOOR_PRE_MD5 = '79b411db1991b00e04e6cfce647843a0';
const DOOR_POST_MD5 = '06d5804f17044e8a2b98c827bc251f0c';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation(');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const DOOR = body(SQL);

/** The misdeal clause's refusal condition, from `IF (n = 1` to its THEN. */
function misdealRefusal(door: string): string {
  const a = door.indexOf('      IF (n = 1 AND NOT (v_dispatched');
  expect(a).toBeGreaterThan(0);
  const z = door.indexOf(' THEN\n', a);
  return door.slice(a, z);
}

describe('an abandoned first hand of an event that never dealt is a misdeal', () => {
  it('installs exactly the reviewed door body over the production pre-image', () => {
    expect(md5(body(PRIOR))).toBe(DOOR_PRE_MD5);
    expect(md5(DOOR)).toBe(DOOR_POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${DOOR_PRE_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${DOOR_POST_MD5}'`);
    expect(SQL).toMatch(/^-- @live-proof: .*'06d5804f17044e8a2b98c827bc251f0c'$/m);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('no longer refuses a misdeal merely because the table has no earlier hand', () => {
    const before = misdealRefusal(body(PRIOR));
    const after = misdealRefusal(DOOR);
    expect(before).toContain('         OR v_last.id IS NULL\n');
    expect(after).not.toContain('         OR v_last.id IS NULL\n');
  });

  it('accepts a first hand only when the event never committed a hand and every chair holds the starting chips', () => {
    const after = misdealRefusal(DOOR);
    const first = after.slice(after.indexOf('OR (v_last.id IS NULL'));
    expect(first).toContain(
      'EXISTS (SELECT 1 FROM public.hand_history hx WHERE hx.tournament_id = t)'
    );
    expect(first).toMatch(
      /hand_history hx\s+JOIN public\.tables tx ON tx\.id = hx\.table_id\s+WHERE tx\.tournament_id = t/
    );
    expect(first).toMatch(
      /hand_atomic_commits cx\s+JOIN public\.tables tx ON tx\.id = cx\.table_id\s+WHERE tx\.tournament_id = t/
    );
    expect(first).toContain('event.starting_chips IS NULL OR event.starting_chips <= 0');
    expect(first).toContain(
      "WHERE (r->>'stack')::numeric IS DISTINCT FROM event.starting_chips::numeric"
    );
    // The roster check that every chair equals its registration is unchanged.
    expect(DOOR).toContain("OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)");
  });

  it('keeps the last-committed-hand comparison for every table that has one', () => {
    const after = misdealRefusal(DOOR);
    expect(after).toContain('OR (v_last.id IS NOT NULL');
    expect(after).toContain("jsonb_typeof(v_last.players) IS DISTINCT FROM 'array'");
    expect(after).toContain("AND (x->>'stack')::numeric = (r->>'stack')::numeric");
    // Every other refusal of the clause is still there.
    expect(after).toContain('public.hand_discards x');
    expect(after).toContain("WHERE r->>'user_id' = c.user_id::text");
    expect(DOOR).toContain("RAISE EXCEPTION 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT'");
  });

  it('changes nothing else in the door', () => {
    // Put the old clause and receipt back and the production pre-image returns.
    const prior = body(PRIOR);
    const oldClause = misdealRefusal(prior);
    const newClause = misdealRefusal(DOOR);
    let reverted = DOOR.replace(newClause, oldClause);
    reverted = reverted.replace(
      "        'first_hand_of_event', v_last.id IS NULL,\n        'starting_chips', event.starting_chips,\n",
      ''
    );
    const docA = reverted.indexOf('      --     ante or bet of the void hand ever left a chair;\n');
    const docZ = reverted.indexOf(
      '      -- Otherwise the refusal this shape always had is raised, unchanged.'
    );
    expect(docA).toBeGreaterThan(0);
    reverted =
      reverted.slice(0, docA) +
      '      --     ante or bet of the void hand ever left a chair.\n' +
      reverted.slice(docZ);
    expect(md5(reverted)).toBe(DOOR_PRE_MD5);
  });

  it('moves no money and stays service_role only', () => {
    expect(DOOR).toContain("'credit', 0);");
    expect(DOOR).not.toMatch(/UPDATE public\.(table_seats|tournament_players)\b/);
    expect(DOOR).not.toMatch(/INSERT INTO public\.(chip_ledger|wallet_transactions)\b/);
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*TO service_role;/
    );
  });
});
