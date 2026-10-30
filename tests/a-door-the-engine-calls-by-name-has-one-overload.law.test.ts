/**
 * A DOOR THE ENGINE CALLS BY NAME HAS ONE OVERLOAD (2026-09-28).
 *
 * PostgREST resolves `supabase.rpc('fn_x', { a, b })` by NAME and by the set
 * of named arguments. When two overloads of fn_x both accept that set - the
 * old `(a, b)` and a new `(a, b, c DEFAULT NULL)` - it refuses the call
 * outright with PGRST203 ("Could not choose the best candidate function").
 *
 * That happened on production at 14:49:15Z on 2026-09-28. Migration
 * 20260928144831 meant to add `p_request_id uuid DEFAULT NULL` to
 * fn_consume_time_bank with CREATE OR REPLACE, which in Postgres does not
 * replace a function whose argument list changed: it creates a second one.
 * Every time-bank debit the engine sent from then on was refused, each
 * refusal tainted its table engine's time-bank custody for the life of the
 * process, and 42 decided SNG/Spin events could not be finished because the
 * managers holding them could no longer retire. Fixed by
 * 20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql.
 *
 * Two pins:
 *
 *  1. fn_consume_time_bank specifically: every migration that creates it with
 *     an argument list other than `(uuid, integer)` is followed, in version
 *     order, by a migration that drops `fn_consume_time_bank(uuid, integer)`,
 *     and the drop migration keeps its exact pre-image guard and its
 *     one-overload post-image assertion.
 *
 *  2. From this law forward, any migration that CREATE (OR REPLACE)s a
 *     function which an earlier migration created with a DIFFERENT argument
 *     list must drop the earlier signature, in the same file or a later one.
 *     Older files are history (CLAUDE.md check-migrations-applied: they are
 *     "intentionally stale") and are only read to learn the earlier shape.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogSQLUnits } from './helpers/migrationSQLUnits';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const DROP_FILE = '20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql';
/** Files at or after this version must drop what they overload. */
const LAW_FROM = '20260928154352';

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  varchar: 'character varying',
  timestamptz: 'timestamp with time zone',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
};

/** First words of the built-in types that are spelled with a space. */
const MULTIWORD_TYPE_START = new Set([
  'timestamp',
  'time',
  'double',
  'character',
  'bit',
  'interval',
  'national',
]);

/** Split a top-level comma list (parentheses, e.g. numeric(12,2), stay whole). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The input types of one argument list, defaults and names removed. */
function inputTypes(args: string): string[] {
  return splitTopLevel(args)
    .map((raw) => raw.replace(/\s+(default|=)\s[\s\S]*$/i, '').trim())
    .filter((a) => !/^out\s/i.test(a))
    .map((a) => a.replace(/^(in|inout|variadic)\s+/i, ''))
    .map((a) => {
      const words = a.toLowerCase().replace(/\s+/g, ' ').split(' ');
      // "p_user_id uuid" -> uuid; a bare type ("uuid", "timestamp with time zone") stays.
      const typeWords =
        words.length > 1 && !MULTIWORD_TYPE_START.has(words[0]) ? words.slice(1) : words;
      const t = typeWords
        .join(' ')
        .replace(/\(.*\)$/, '')
        .trim();
      return TYPE_ALIASES[t] ?? t;
    });
}

interface Created {
  file: string;
  name: string;
  types: string[];
}

const CREATE_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\)\s*(?:returns|language)\b/gi;
const DROP_RE =
  /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)/gi;

function declarations(file: string, source: string) {
  const units = catalogSQLUnits(source);
  const creates: Array<Created & { offset: number }> = [];
  const drops: Array<Created & { offset: number }> = [];
  for (const unit of units) {
    const sql = stripComments(unit.sql);
    for (const m of sql.matchAll(CREATE_RE))
      creates.push({
        file,
        name: m[1].toLowerCase(),
        types: inputTypes(m[2]),
        offset: unit.offset + m.index,
      });
    for (const m of sql.matchAll(DROP_RE))
      drops.push({
        file,
        name: m[1].toLowerCase(),
        types: inputTypes(m[2]),
        offset: unit.offset + m.index,
      });
  }
  creates.sort((a, b) => a.offset - b.offset);
  drops.sort((a, b) => a.offset - b.offset);
  return { file, sql: stripComments(units[0].sql), creates, drops };
}

const parsed = files.map((file) => declarations(file, readFileSync(join(DIR, file), 'utf8')));

const sig = (types: string[]) => types.join(',');

/**
 * Overloads that coexist on production on purpose, each with the reason no
 * named-argument call can match more than one of them (so PGRST203 cannot
 * arise). A pair listed here is not a "signature change"; anything else is.
 *
 * fn_thaw_platform: the v3 thaw (announced_at, freeze_started, frozen_seconds,
 * ownership_token, thawed_by) was installed by
 * 20260909180615_maintenance_ownership_fits_process_lifetime, which is held
 * back from this directory for the maintenance lane, beside the legacy
 * (freeze_started, frozen_seconds, thawed_by) door. The v3 door requires
 * p_announced_at and p_ownership_token with no default, and the legacy door
 * has neither parameter, so no named-argument set is accepted by both. The
 * engine calls only the v3 door (GameServer: runMaintenanceThawV3).
 * 20261002165326 replaces the v3 body in place.
 *
 * Phase 1 customization: the four owner-bound doors require
 * p_expected_user_id (and the theme door also requires p_mutation_id). The
 * legacy doors declare neither name, so an old call cannot match the new door
 * and a new call cannot match the old one. The old doors remain only through
 * the measured compatible-client cutover, after which 20261005111523 revokes
 * their browser execution.
 */
const DELIBERATE_OVERLOADS: Record<string, string[]> = {
  // Existing SQL compatibility door delegates to the service-only two-argument
  // door. The latter requires p_seat_first_internal, with no default: neither
  // named-argument set can match both. Do not drop the compatibility caller.
  fn_register_for_tournament: ['uuid', 'uuid,boolean'],
  // Existing current-viewer and explicit-user RLS helpers. p_user_id is required
  // on the explicit helper, absent on the viewer helper, so RPC names disambiguate.
  is_club_admin: ['uuid', 'uuid,uuid'],
  fn_thaw_platform: [
    'timestamp with time zone,numeric,text',
    'timestamp with time zone,timestamp with time zone,numeric,uuid,text',
  ],
  fn_set_interface_theme: ['text', 'uuid,uuid,text'],
  fn_mark_table_setting_touched: ['text[]', 'uuid,text[]'],
  fn_seed_table_studio_preferences: ['text[],jsonb', 'uuid,text[],jsonb'],
  fn_mutate_table_studio_preferences: [
    'text,boolean,integer,jsonb',
    'uuid,text,boolean,integer,jsonb',
  ],
};
const deliberatePair = (name: string, a: string, b: string): boolean =>
  (DELIBERATE_OVERLOADS[name] ?? []).includes(a) && (DELIBERATE_OVERLOADS[name] ?? []).includes(b);

function signatureOffenders(migrations: typeof parsed): string[] {
  const lastSeen = new Map<string, string>();
  const offenders: string[] = [];
  migrations.forEach(({ file, creates }, index) => {
    for (const c of creates) {
      // Pre-law dynamic templates are history, not concrete type signatures.
      // Keep the last known ABI rather than replacing it with format's %s.
      // New migrations remain subject to the normal conservative checks.
      if (file < LAW_FROM && c.types.some((type) => /%(?:\d+\$)?[sIL]/.test(type))) continue;
      const previous = lastSeen.get(c.name);
      const now = sig(c.types);
      if (
        file >= LAW_FROM &&
        previous !== undefined &&
        previous !== now &&
        !deliberatePair(c.name, previous, now)
      ) {
        const dropped = migrations
          .slice(index)
          .some(({ drops }) => drops.some((d) => d.name === c.name && sig(d.types) === previous));
        if (!dropped) offenders.push(`${file}: ${c.name}(${previous}) -> (${now}) without a drop`);
      }
      lastSeen.set(c.name, now);
    }
    // A dropped signature is no longer the one a later file replaces.
    for (const d of migrations[index].drops) {
      if (lastSeen.get(d.name) === sig(d.types)) lastSeen.delete(d.name);
    }
  });
  return offenders;
}

describe('a door the engine calls by name has one overload', () => {
  it('keeps catalog JSON definitions separate from the next real helper', () => {
    const snapshot = {
      owners: [
        {
          definition:
            'CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()\nRETURNS trigger LANGUAGE plpgsql AS $function$BEGIN -- stored comment\nRETURN NEW;END;$function$',
        },
      ],
    };
    const source = `DO $guard$DECLARE expected jsonb:=$snapshot$${JSON.stringify(snapshot)}$snapshot$::jsonb;BEGIN NULL;END$guard$;
      CREATE FUNCTION smarter_private.native_helper(p_value jsonb) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;`;
    const result = declarations('fixture', source);
    expect(result.creates.map(({ name, types }) => ({ name, types }))).toEqual([
      { name: 'fn_award_vip_points_from_rake', types: [] },
    ]);
  });

  it('still sees actual, dynamic and JSON-extracted CREATE and DROP signatures', () => {
    const json = {
      sql: 'CREATE FUNCTION public.dynamic_json(p_id uuid, p_key text)\nRETURNS void LANGUAGE sql AS $$SELECT NULL$$; DROP FUNCTION public.dynamic_json(uuid);',
    };
    const source = `CREATE FUNCTION public.actual(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;
      DO $do$BEGIN EXECUTE 'CREATE FUNCTION public.dynamic(p_id uuid) RETURNS void LANGUAGE sql AS $b$SELECT NULL$b$';END$do$;
      DO $guard$DECLARE j jsonb:=$snapshot$${JSON.stringify(json)}$snapshot$::jsonb;BEGIN EXECUTE(j->>'sql');END$guard$;`;
    const result = declarations('fixture', source);
    expect(result.creates.map(({ name, types }) => ({ name, types }))).toEqual([
      { name: 'actual', types: ['uuid'] },
      { name: 'dynamic', types: ['uuid'] },
      { name: 'dynamic_json', types: ['uuid', 'text'] },
    ]);
    expect(result.drops.map(({ name, types }) => ({ name, types }))).toEqual([
      { name: 'dynamic_json', types: ['uuid'] },
    ]);
    const baseline = declarations(
      '99999999999990_base.sql',
      'CREATE FUNCTION public.actual(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$; ' +
        'CREATE FUNCTION public.dynamic(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$; ' +
        'CREATE FUNCTION public.dynamic_json(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$; ' +
        'CREATE FUNCTION public.dynamic_json_key(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;'
    );
    for (const [name, changed] of [
      [
        'actual',
        'CREATE FUNCTION public.actual(p_id uuid,p_key text) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;',
      ],
      [
        'dynamic',
        `DO $do$BEGIN EXECUTE 'CREATE FUNCTION public.dynamic(p_id uuid,p_key text) RETURNS void LANGUAGE sql AS $b$SELECT NULL$b$';END$do$;`,
      ],
      [
        'dynamic_json',
        `DO $do$DECLARE j jsonb:=$j$${JSON.stringify({ sql: 'CREATE FUNCTION public.dynamic_json(p_id uuid,p_key text) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;' })}$j$::jsonb;BEGIN EXECUTE(j->>'sql');END$do$;`,
      ],
      [
        'dynamic_json_key',
        `DO $do$DECLARE j jsonb:=$j$${JSON.stringify({ 'CREATE FUNCTION public.dynamic_json_key(p_id uuid,p_key text) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;': true })}$j$::jsonb;k text;BEGIN FOR k IN SELECT jsonb_object_keys(j) LOOP EXECUTE k;END LOOP;END$do$;`,
      ],
    ]) {
      const offender = declarations('99999999999991_changed.sql', changed);
      expect(signatureOffenders([baseline, offender])).toEqual([
        `99999999999991_changed.sql: ${name}(uuid) -> (uuid,text) without a drop`,
      ]);
      const dropped = declarations(
        '99999999999991_changed.sql',
        changed + ` DROP FUNCTION public.${name}(uuid);`
      );
      expect(signatureOffenders([baseline, dropped])).toEqual([]);
    }
  });

  it('a historical format placeholder cannot replace a known signature', () => {
    const original = declarations(
      '20260901000000_base.sql',
      'CREATE FUNCTION public.fixture(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;'
    );
    const template = declarations(
      '20260902000000_body_patch.sql',
      "DO $$BEGIN EXECUTE format('CREATE OR REPLACE FUNCTION public.fixture(%s) RETURNS void LANGUAGE sql AS %L', v_args, v_body);END$$;"
    );
    const same = declarations(
      '99999999999990_same.sql',
      'CREATE OR REPLACE FUNCTION public.fixture(p_id uuid) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;'
    );
    expect(signatureOffenders([original, template, same])).toEqual([]);
    const changed = declarations(
      '99999999999991_changed.sql',
      'CREATE OR REPLACE FUNCTION public.fixture(p_id uuid,p_key text) RETURNS void LANGUAGE sql AS $$SELECT NULL$$;'
    );
    expect(signatureOffenders([original, template, changed])).toEqual([
      '99999999999991_changed.sql: fixture(uuid) -> (uuid,text) without a drop',
    ]);
  });

  it('reads implicit and explicit OUT records without consuming the body or following function', () => {
    for (const [file, nextName] of [
      [
        '20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side.sql',
        'fn_poker_diamond_jackpot_stake_scope',
      ],
      [
        '20261013034406_a_diamond_jackpot_carries_its_whole_unpaid_allocation.sql',
        'fn_poker_diamond_jackpot_withdraw',
      ],
    ]) {
      const declarations = [
        ...stripComments(readFileSync(join(DIR, file), 'utf8')).matchAll(CREATE_RE),
      ];
      const allocator = declarations.filter(
        (match) => match[1] === 'fn_poker_diamond_jackpot_allocate'
      );
      expect(allocator).toHaveLength(1);
      expect(inputTypes(allocator[0][2])).toEqual(['uuid', 'bigint']);
      expect(allocator[0][2]).not.toContain('v_split');
      expect(allocator[0][2]).not.toContain('CREATE OR REPLACE');
      expect(declarations.some((match) => match[1] === nextName)).toBe(true);
      expect(inputTypes(declarations.find((match) => match[1] === nextName)![2])).toEqual(
        nextName.endsWith('withdraw') ? ['uuid', 'uuid'] : ['numeric']
      );
    }
  });

  it('the engine calls fn_consume_time_bank by name with named arguments', () => {
    const engine = readFileSync(
      join(__dirname, '..', 'server', 'src', 'engine', 'ServerTableEngineBase.ts'),
      'utf8'
    );
    expect(engine).toMatch(/rpc\('fn_consume_time_bank',\s*\{/);
  });

  it('every new fn_consume_time_bank signature is followed by the drop of (uuid, integer)', () => {
    const offenders: string[] = [];
    // A signature is new where it is first created; re-creating the same
    // three-argument door later (CREATE OR REPLACE of the one door) adds no
    // overload, so the drop is looked for after the FIRST creation.
    const firstCreated = new Map<string, number>();
    parsed.forEach(({ creates }, index) => {
      for (const c of creates) {
        if (c.name !== 'fn_consume_time_bank') continue;
        if (!firstCreated.has(sig(c.types))) firstCreated.set(sig(c.types), index);
      }
    });
    parsed.forEach(({ file, creates }) => {
      for (const c of creates) {
        if (c.name !== 'fn_consume_time_bank') continue;
        if (sig(c.types) === 'uuid,integer') continue;
        const dropped = parsed
          .slice(firstCreated.get(sig(c.types)))
          .some(({ drops }) =>
            drops.some((d) => d.name === 'fn_consume_time_bank' && sig(d.types) === 'uuid,integer')
          );
        if (!dropped) offenders.push(`${file}: fn_consume_time_bank(${sig(c.types)})`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('the drop is guarded on its exact pre-image and asserts one door after', () => {
    const sql = readFileSync(join(DIR, DROP_FILE), 'utf8');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql.trim()).toMatch(/COMMIT;$/);
    expect(sql).toContain("'7832bfb717daaeb625372bdd3ccc7d60'");
    expect(sql).toContain("'6adbdcd86c910c09e56b4f10193d2e55'");
    expect(sql).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(sql).toContain('p_request_id uuid DEFAULT NULL::uuid');
    expect(sql).toMatch(/DROP FUNCTION public\.fn_consume_time_bank\(uuid, integer\)/);
    // Where the three-argument door does not exist, it drops nothing.
    expect(sql).toMatch(/IF v_three IS NULL THEN[\s\S]*?RETURN;/);
    expect(sql).toMatch(/post-image has % overloads, expected exactly one/);
  });

  it('from this law forward, a migration that changes a function signature drops the old one', () => {
    const offenders = signatureOffenders(parsed);
    expect(offenders).toEqual([]);
  });

  it('a deliberate overload pair really is disjoint by required named arguments', () => {
    const adminDefinitions = parsed
      .flatMap(({ creates }) => creates)
      .filter((c) => c.name === 'is_club_admin');
    expect(adminDefinitions.some((c) => sig(c.types) === 'uuid')).toBe(true);
    const explicitAdmins = parsed
      .flatMap(({ sql }) => [...sql.matchAll(CREATE_RE)])
      .filter(
        (match) => match[1].toLowerCase() === 'is_club_admin' && inputTypes(match[2]).length === 2
      );
    expect(explicitAdmins.length).toBeGreaterThan(0);
    for (const definition of explicitAdmins) {
      expect(definition[2]).toMatch(/p_user_id uuid\s*$/i);
      expect(definition[2]).not.toMatch(/default|=/i);
    }
    const registration = parsed
      .flatMap(({ sql }) => [...sql.matchAll(CREATE_RE)])
      .filter((match) => match[1].toLowerCase() === 'fn_register_for_tournament')
      .filter((match) => /p_seat_first_internal/i.test(match[2]))
      .at(-1);
    expect(registration, 'registration has no two-argument definition').toBeDefined();
    expect(registration![2]).toMatch(/p_seat_first_internal boolean\s*$/i);
    expect(registration![2]).not.toMatch(/default|=/i);
    const compatibility = parsed
      .flatMap(({ sql }) => [...sql.matchAll(CREATE_RE)])
      .filter((match) => match[1].toLowerCase() === 'fn_register_for_tournament')
      .filter((match) => sig(inputTypes(match[2])) === 'uuid')
      .at(-1);
    expect(compatibility, 'registration has no compatibility definition').toBeDefined();
    expect(compatibility![2]).not.toMatch(/p_seat_first_internal/i);
    // The v3 thaw door keeps p_announced_at and p_ownership_token with no
    // default, and the legacy door declares neither, so no call can match both.
    const v3 = parsed
      .flatMap(({ sql }) => [
        ...sql.matchAll(
          /create\s+or\s+replace\s+function\s+public\.fn_thaw_platform\s*\(([\s\S]*?)\)\s*returns/gi
        ),
      ])
      .map((m) => m[1])
      .filter((args) => /p_ownership_token/.test(args));
    expect(v3.length, 'no migration here replaces the v3 thaw door').toBeGreaterThan(0);
    for (const args of v3) {
      expect(args).toMatch(/p_announced_at timestamp with time zone,/);
      expect(args).toMatch(/p_ownership_token uuid,/);
      expect(args).not.toMatch(/p_announced_at[^,]*default/i);
      expect(args).not.toMatch(/p_ownership_token[^,]*default/i);
    }

    const ownerBoundDoors = [
      'fn_set_interface_theme',
      'fn_mark_table_setting_touched',
      'fn_seed_table_studio_preferences',
      'fn_mutate_table_studio_preferences',
    ];
    for (const name of ownerBoundDoors) {
      const definitions = parsed
        .flatMap(({ sql }) => [
          ...sql.matchAll(
            new RegExp(
              `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(([\\s\\S]*?)\\)\\s*returns`,
              'gi'
            )
          ),
        ])
        .map((match) => match[1]);
      expect(
        definitions.some((args) => !/p_expected_user_id/i.test(args)),
        `${name} has no legacy definition`
      ).toBe(true);
      const ownerBound = definitions.find((args) => /p_expected_user_id/i.test(args));
      expect(ownerBound, `${name} has no owner-bound definition`).toBeDefined();
      expect(ownerBound).toMatch(/p_expected_user_id uuid,/i);
      expect(ownerBound).not.toMatch(/p_expected_user_id[^,]*default/i);
    }
  });
});
