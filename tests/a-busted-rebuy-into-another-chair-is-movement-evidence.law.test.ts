/**
 * A BUSTED REBUY INTO ANOTHER CHAIR, AND A NEVER-DEALT ADD-ON, ARE MOVEMENT
 * EVIDENCE (2026-10-24)
 *
 * G2. A player who busted in the proven hand, then rebought or re-entered and
 * was seated in a different chair (process_tournament_rebuy lets
 * fn_ca_choose_tournament_seat_locked pick the table with the most free
 * chairs, so usually on another table), refused the dealt proof with
 * F06_MOVEMENT_SEAT_CHANGED: the purchase loop raised the held stack to the
 * grant and the seat lookup found only the vacated (or re-taken) old chair.
 *
 * G3. A never-dealt chair whose entry, rebuy or arrival was proven, and whose
 * player then bought an add-on, refused F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN.
 *
 * R. The refunded-earlier-entry rule now also requires that other receipt to
 * predate the current registration itself.
 *
 * 20261025082356 inserts anchored passages into both installed definitions.
 * It replaces 20261025030421 (merged, never installed: its never-dealt
 * pre-image had moved to 35dbc3c7 under 20261025052637, a refunded diamond
 * or free entry is not a second entry), with the same passages re-based.
 * This law rebuilds both pre-images from the migrations that installed them,
 * applies the file's own anchor pairs, and checks the result is exactly the
 * post-image the file asserts; that removing every passage is the pre-image;
 * the conditions each rule rests on; that a proof needing none of them takes
 * the old path; and that the file writes no row.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261025082356_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql';
const REPLACED = '20261025030421_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const PRIOR_PRE_SRC = 'd21b415b4754a19147cce0160de59479';
const PRIOR_PRE_DEF = 'ddbca56b65a99f017fb86e791b2fb971';
const PRIOR_POST_SRC = 'ab72d64575eae5cf77e6b004dd5ee5f6';
const PRIOR_POST_DEF = '0c3f0b7cb997eb761a7295d49df24bc9';
const ND_PRE_SRC = '2962ab899304584d3ad1ae1d14b3e8dc';
const ND_PRE_DEF = '35dbc3c7dd7b152d8e55892b4af9ae3b';
const ND_POST_SRC = 'dbda1e1dab654980f31706a04f8b6de5';
const ND_POST_DEF = '0ff3bcaef0476a3dc46d6d6931515bb7';
// The same passages proved against the never-dealt body before 052637
// (20261025030421: pre e0677c7a, post f0fd3fdf).
const ND_BEFORE_DIAMOND_SRC = 'e0677c7a9a3e1bbed2cd00026caee54a';
const ND_BEFORE_DIAMOND_POST_SRC = 'f0fd3fdfbdbb25c9390ad3f987e6e0cf';

/** The body between `AS <tag>` and the closing tag of the first CREATE of fn in sql. */
function body(sql: string, fn: string, tag: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION smarter_private.${fn}(`);
  expect(start, `defines ${fn}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

/** Evaluate a SQL expression made of '...' literals and chr(10) joined by ||. */
function sqlConcat(expr: string): string {
  let out = '';
  const re = /'((?:[^']|'')*)'|chr\(10\)/g;
  for (const m of expr.matchAll(re)) out += m[1] !== undefined ? m[1].replace(/''/g, "'") : '\n';
  return out;
}

/** The anchor pairs of one DO block of this file: [find[], repl[]]. */
function pairs(tag: string): [string[], string[]] {
  const blk = SQL.slice(SQL.indexOf(`DO $${tag}$`), SQL.indexOf(`$${tag}$;`));
  const arr = (name: string) => {
    const rest = blk.slice(blk.indexOf(`${name} := ARRAY[`));
    const text = rest.slice(0, rest.search(/\$[a-d][0-9]\$\];/) + 6);
    return [...text.matchAll(/\$([a-d][0-9])\$([\s\S]*?)\$\1\$/g)].map((m) => m[2]);
  };
  return [arr('v_find'), arr('v_repl')];
}

const once = (hay: string, needle: string) => hay.split(needle).length - 1;
function apply(pre: string, find: string[], repl: string[]): string {
  let src = pre;
  find.forEach((f, i) => {
    expect(once(src, f), `anchor ${i + 1} is found exactly once`).toBe(1);
    src = src.replace(f, () => repl[i]);
  });
  return src;
}
function unapply(post: string, find: string[], repl: string[]): string {
  let src = post;
  for (let i = find.length - 1; i >= 0; i--) {
    expect(once(src, repl[i]), `passage ${i + 1} is found exactly once`).toBe(1);
    src = src.replace(repl[i], () => find[i]);
  }
  return src;
}

// The installed pre-images, rebuilt from the migrations that installed them.
const PRIOR_PRE = body(
  read('20261024211825_a_rebuy_seated_from_another_table_is_movement_evidence.sql'),
  'f06_movement_prior',
  '$cross_table_rebuy_prior$'
);
/** One anchored replace of a migration written as v_find := ...; replace(v_src, v_find, ...). */
function anchoredEdit(sql: string, src: string): string {
  const find = sqlConcat(
    sql.slice(sql.indexOf('v_find :='), sql.indexOf(';', sql.indexOf('v_find :=')))
  );
  const key = 'v_src := replace(v_src, v_find,';
  const at = sql.indexOf(key) + key.length;
  const repl = sqlConcat(sql.slice(at, sql.indexOf('));', at) + 1));
  expect(once(src, find)).toBe(1);
  return src.replace(find, () => repl);
}
/** 20261025052637's file, found by its block tag (installed; its PR may not be on main yet). */
const DIAMOND_FILE = readdirSync(MIGRATIONS).find(
  (f) => f.endsWith('.sql') && read(f).includes('DO $refunded_diamond_entry$')
);
function neverDealtBeforeDiamond(): string {
  const base = body(
    read('20261021172832_never_dealt_arrivals_keep_their_committed_move.sql'),
    'f06_movement_never_dealt_prior',
    '$function$'
  );
  // 20261024232734 edits that body by one anchored replace.
  return anchoredEdit(
    read('20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql'),
    base
  );
}
const ND_BEFORE_DIAMOND = neverDealtBeforeDiamond();
// 052637 edits it by one more anchored replace. Until its file reaches this
// tree the full chain cannot be rebuilt here; the migration itself asserts the
// live pre-image (35dbc3c7) before it edits anything.
const ND_PRE = DIAMOND_FILE ? anchoredEdit(read(DIAMOND_FILE), ND_BEFORE_DIAMOND) : null;
const [PRIOR_FIND, PRIOR_REPL] = pairs('rechaired');
const [ND_FIND, ND_REPL] = pairs('never_dealt_addon');
const PRIOR_POST = apply(PRIOR_PRE, PRIOR_FIND, PRIOR_REPL);
const ND_POST = ND_PRE === null ? null : apply(ND_PRE, ND_FIND, ND_REPL);
/** The never-dealt post-image this tree can rebuild, for the shape checks. */
const ND_SHAPE = ND_POST ?? apply(ND_BEFORE_DIAMOND, ND_FIND, ND_REPL);
const CODE = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('a busted rebuy into another chair, and a never-dealt add-on, are movement evidence', () => {
  it('starts from exactly the bodies production holds and installs exactly the stated post-images', () => {
    expect(md5(PRIOR_PRE)).toBe(PRIOR_PRE_SRC);
    expect(md5(PRIOR_POST)).toBe(PRIOR_POST_SRC);
    // The never-dealt passages are exactly the ones proved before 052637 ...
    expect(md5(ND_BEFORE_DIAMOND)).toBe(ND_BEFORE_DIAMOND_SRC);
    const beforeDiamond = apply(ND_BEFORE_DIAMOND, ND_FIND, ND_REPL);
    expect(md5(beforeDiamond)).toBe(ND_BEFORE_DIAMOND_POST_SRC);
    expect(unapply(beforeDiamond, ND_FIND, ND_REPL)).toBe(ND_BEFORE_DIAMOND);
    expect(read(REPLACED)).toContain(`<> '${ND_BEFORE_DIAMOND_POST_SRC}'`);
    // ... and, once 052637's file is in the tree, on its post-image.
    if (ND_PRE !== null && ND_POST !== null) {
      expect(md5(ND_PRE)).toBe(ND_PRE_SRC);
      expect(md5(ND_POST)).toBe(ND_POST_SRC);
    }
    expect(SQL).toContain(`IF md5(v_pre) <> '${PRIOR_PRE_DEF}'`);
    expect(SQL).toContain(
      `(SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '${PRIOR_PRE_SRC}'`
    );
    expect(SQL).toContain(`IF md5(v_pre) <> '${ND_PRE_DEF}'`);
    expect(SQL).toContain(`(SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '${ND_PRE_SRC}'`);
    for (const [src, def, fn] of [
      [PRIOR_POST_SRC, PRIOR_POST_DEF, 'f06_movement_prior(uuid,uuid)'],
      [ND_POST_SRC, ND_POST_DEF, 'f06_movement_never_dealt_prior(uuid,uuid,uuid)'],
    ]) {
      expect(SQL).toContain(`IF md5(v_src) <> '${def}' THEN`);
      expect(SQL).toContain(`(SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '${src}'`);
      expect(SQL).toContain(
        `-- @live-proof: (SELECT md5(prosrc)='${src}' AND md5(pg_get_functiondef(oid))='${def}' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.${fn}'::regprocedure)`
      );
    }
  });

  it('replaces 20261025030421, which is marked never to run', () => {
    expect(read(REPLACED).startsWith('-- SUPERSEDED BY 20261025082356\n')).toBe(true);
    // The same passages, re-based: the two DO blocks differ only in their md5s.
    for (const tag of ['rechaired', 'never_dealt_addon']) {
      const block = (sql: string) =>
        sql.slice(sql.indexOf(`DO $${tag}$`), sql.indexOf(`$${tag}$;`));
      const strip = (b: string) => b.replace(/'[0-9a-f]{32}'/g, "'md5'");
      expect(strip(block(SQL))).toBe(strip(block(read(REPLACED))));
    }
  });

  it('only inserts: removing every passage is each pre-image byte for byte, and the file asserts it', () => {
    expect(PRIOR_FIND).toHaveLength(6);
    expect(ND_FIND).toHaveLength(9);
    expect(unapply(PRIOR_POST, PRIOR_FIND, PRIOR_REPL)).toBe(PRIOR_PRE);
    if (ND_PRE !== null && ND_POST !== null)
      expect(unapply(ND_POST, ND_FIND, ND_REPL)).toBe(ND_PRE);
    // Every replacement keeps its anchor's text, in order, with text added.
    [
      ...PRIOR_FIND.map((f, i) => [f, PRIOR_REPL[i]]),
      ...ND_FIND.map((f, i) => [f, ND_REPL[i]]),
    ].forEach(([f, r]) => {
      expect(r.length).toBeGreaterThan(f.length);
      let at = 0;
      for (const ch of f) {
        at = r.indexOf(ch, at);
        expect(at).toBeGreaterThanOrEqual(0);
        at += 1;
      }
    });
    expect(SQL.match(/IF v_back IS DISTINCT FROM v_pre THEN/g)).toHaveLength(2);
  });

  it('G2: admits the other chair only by the purchase result of a bust in exactly this hand', () => {
    const passage = PRIOR_REPL[3];
    for (const condition of [
      "IF (x->>'stack')::numeric=0 AND bought>=1 AND rekey IS NOT NULL AND NOT item ? 'credit' THEN",
      "WHERE q.key_domain='tournament_chip_purchase' AND q.idempotency_key=rekey",
      "AND q.request->>'version'='v1' AND q.request->>'user_id'=x->>'user_id'",
      "AND q.response->'success'='true'::jsonb AND q.response->'seated'='true'::jsonb",
      "AND q.response->>'atomic_tournament_chip_purchase'='v1' AND q.response->>'rebuy_type'=reop",
      "AND q.response->>'candidate_id'=kc.id::text AND q.response->>'candidate_state'='rebought'",
      "AND (q.response->>'stack')::numeric=regain AND (q.response->>'new_stack')::numeric=regain",
      "AND q.response->>'seat_id' IS DISTINCT FROM x->>'seat_id'",
      'AND kc.table_id=p_table AND kc.hand_id=a.hand_id AND kc.hand_number=a.hand_number',
      "AND kc.seat_id=(x->>'seat_id')::uuid AND kc.seat_joined_at=(x->>'seat_joined_at')::timestamptz",
      'AND kc.stack_after=0 AND kc.resolved_at IS NOT NULL AND kc.resolved_at>=rebought',
      // the chair this hand dealt holds nothing of the player
      'AND os.left_at IS NOT NULL AND os.stack=0)',
      'AND os.joined_at>a.committed_at));',
      // departed: plays in exactly that chair there, holds no chair here
      "OR registration.table_id::text IS DISTINCT FROM repurchase.response->>'table_id'",
      "OR registration.seat_number IS DISTINCT FROM (repurchase.response->>'seat_number')::integer",
      "AND nt.tournament_id=p_tournament AND ns.user_id=(x->>'user_id')::uuid AND ns.seat_number=registration.seat_number",
      "OR EXISTS(SELECT 1 FROM public.table_seats ns WHERE ns.table_id=p_table AND ns.user_id=(x->>'user_id')::uuid AND ns.left_at IS NULL) THEN",
      "RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;",
      'departed:=departed||jsonb_build_array(',
      " CONTINUE;\n END IF;\n SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table\n",
    ])
      expect(passage, condition).toContain(condition);
    // The first purchase since the hand names the key; the existing seat,
    // registration and roster checks then prove the chair on this table.
    expect(PRIOR_REPL[2]).toContain(
      "IF bought=1 AND p.op IN ('rebuy','reentry') THEN rekey:=p.k; reop:=p.op; regain:=gained; END IF;"
    );
    expect(PRIOR_REPL[4]).toContain(
      "SELECT * INTO seat FROM public.table_seats WHERE id=(repurchase.response->>'seat_id')::uuid AND table_id=p_table"
    );
    expect(PRIOR_POST).toContain(
      ' IF NOT FOUND OR seat.stack IS DISTINCT FROM held OR seat.occupancy_id IS NULL THEN'
    );
    // Recorded under receipts only when used, so other proofs are unchanged.
    expect(PRIOR_REPL[5]).toContain(
      "||CASE WHEN departed='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('departed',departed) END"
    );
    expect(PRIOR_REPL[5]).toContain(
      "||CASE WHEN rechaired='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rechaired',rechaired) END) END;"
    );
  });

  it('G3: takes the rules a second time only when they refused, on the chair before its add-ons', () => {
    const walk = ND_REPL[1];
    for (const condition of [
      "IF topf.operation IS DISTINCT FROM 'addon' THEN topbase:=topf; EXIT; END IF;",
      "topgain:=COALESCE(NULLIF((topf.tournament_snapshot->>'addon_chips')::numeric,0),(topf.tournament_snapshot->>'starting_chips')::numeric,0);",
      "OR (topf.registration_snapshot->>'chips')::numeric IS DISTINCT FROM topcur THEN tops:=NULL; EXIT; END IF;",
      "OR topbase.observed_at>=topfirst THEN tops:='[]'; END IF;",
      "FOR toppass IN 0..CASE WHEN tops='[]'::jsonb THEN 0 ELSE 1 END LOOP",
      'seat.stack:=topcur; registration.chips:=topcur; registration.add_on:=false; fund:=topbase;',
      'topped:=topids; toplegs:=toplegids; topafter:=topfirst;',
    ])
      expect(walk, condition).toContain(condition);
    // Only exactly the walked add-on receipts and their own ledger legs are set aside.
    expect(ND_REPL[2]).toContain('AND f.registration_id=registration.id AND f.id<>ALL(topped))<>1');
    expect(ND_REPL[4]).toContain(
      'AND l.from_entity_id=registration.user_id AND l.id<>ALL(toplegs)));'
    );
    expect(ND_REPL[5]).toContain('later.observed_at>fund.observed_at AND later.id<>ALL(topped))');
    expect(ND_REPL[6]).toContain('later.observed_at>arrival.moved_at AND later.id<>ALL(topped))');
    expect(ND_REPL[6]).toContain('AND (topafter IS NULL OR topafter>arrival.moved_at)');
    // The first pass is today's rules with every set empty; the live rows return before the roster.
    expect(ND_REPL[1]).toContain("topped:='{}'; toplegs:='{}'; topfirst:=NULL; topafter:=NULL;");
    expect(ND_REPL[7]).toContain(
      ' EXIT WHEN entry_proven IS TRUE OR rebuy_proven IS TRUE OR arrival_proven IS TRUE;\n END LOOP;\n seat:=topseat; registration:=topreg;\n'
    );
    expect(ND_REPL[8]).toContain(
      "||CASE WHEN topped='{}' THEN '{}'::jsonb ELSE jsonb_build_object('addons',tops) END);"
    );
    const roster = ND_SHAPE.indexOf(
      " roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat)"
    );
    expect(roster).toBeGreaterThan(ND_SHAPE.indexOf(' seat:=topseat; registration:=topreg;'));
  });

  it('R: another receipt of the player must also predate this registration', () => {
    expect(ND_REPL[3]).toContain(
      'OR f.observed_at>=fund.observed_at OR registration.registered_at IS NULL OR f.observed_at>=registration.registered_at OR f.registration_id IS NULL'
    );
    // The refund-leg sum rule is unchanged.
    expect(ND_SHAPE).toContain('AND l.created_at<fund.observed_at),0)');
  });

  it('never borrows a plpgsql variable name for a query alias', () => {
    const declared = new Set([
      'a',
      'h',
      's',
      'x',
      'p',
      'o',
      'n',
      'item',
      'seat',
      'fund',
      'arrival',
      'movement',
      'member',
      'winner',
      'bust',
      'rb',
      'rf',
    ]);
    for (const passage of [...PRIOR_REPL, ...ND_REPL])
      for (const m of passage.matchAll(/\b(?:FROM|JOIN) public\.\w+ (\w+)\b/g)) {
        if (['ON', 'WHERE', 'ORDER', 'AND', 'LIMIT'].includes(m[1])) continue;
        expect(declared.has(m[1]), `alias ${m[1]}`).toBe(false);
      }
  });

  it('is one transaction that writes no row, keeps owner and ACL, and is the newest definition', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(CODE).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(CODE).not.toMatch(/cron\./i);
    expect(CODE).not.toMatch(/^GRANT |^REVOKE /m);
    for (const k of ['v_acl', 'v_owner', 'v_secdef', 'v_config', 'v_vol'])
      expect(CODE.split(`IS DISTINCT FROM ${k}`).length - 1).toBe(2);
    expect(
      CODE.split(
        "v_acl IS DISTINCT FROM '{postgres=X/postgres}' OR v_owner IS DISTINCT FROM 'postgres'"
      ).length - 1
    ).toBe(2);
    const later = readdirSync(MIGRATIONS).filter(
      (f) =>
        f.endsWith('.sql') &&
        f > FILE &&
        /FUNCTION smarter_private\.f06_movement_(prior|never_dealt_prior)\(/.test(read(f))
    );
    expect(later).toEqual([]);
  });
});
