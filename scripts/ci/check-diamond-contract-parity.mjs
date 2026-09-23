#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND SPINS CONTRACT THE DATABASE SPEAKS AND THE ONE THE CLIENT CAN
 *  READ MUST BE THE SAME CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-23)
 *
 * A session applied four Diamond Spins migrations straight to production - the
 * estate's documented way of applying schema (CLAUDE.md section 2) - and ended
 * without merging the client that matched them:
 *
 *   20260923032317  diamond_spins_prize_legs_keep_their_ledger_rows
 *   20260923032519  diamond_spins_daily_settlement_burns_twenty_percent
 *   20260923033010  the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor
 *   20260923033605  diamond_wheel_v4_draws_a_different_prize_every_time
 *
 * From that moment `public.fn_wheel_state_v2` returned
 * `contract_version: 4, model_version: 'wheel-v4'`. The client on main accepts
 * 2 or 3 and nothing else: `WheelContractVersion` in
 * src/services/DiamondWheelService.ts, and `assertWheelAward` in
 * src/utils/wheelAward.ts, which throws "The Wheel Award Could Not Be
 * Confirmed" on anything it does not recognise. The wheel was dead in
 * production for about nine hours and NOTHING WENT RED, because every gate in
 * this repo compares the repo against the repo, or the repo against a snapshot
 * of the schema. Nothing compared WHAT THE DATABASE SAYS against WHAT THE
 * CLIENT CAN HEAR.
 *
 * The same drift covers two more contracts in the same product:
 *   - the bonus floor: new rounds are sealed with `fn_diamond_bonus_floor`
 *     (half the stake), while src/utils/diamondBonusPayout.ts still declares
 *     that it mirrors `fn_diamond_bonus_minimum` (a tenth of the stake);
 *   - the receipt version: the live CHECK constraints admit `payout_version
 *     >= 4`, while the client's own `payout_version` unions stop at 3.
 *
 * WHAT IT COMPARES. Five contract surfaces, all of them read, never assumed:
 *
 *   1. contract_version     the integer fn_wheel_state_v2 actually returns
 *   2. model_version        the draw domain it names, vs WheelDrawDomain
 *   3. prize-kind vocabulary  DISTINCT kind over the segments the live model
 *                           function produces, vs WheelSegmentKind
 *   4. segment count        jsonb_array_length of the same live segments, vs
 *                           the counts assertWheelAward / assertWheelUpgradeTable
 *                           refuse to accept anything else than
 *   5. the bonus floor rule which fn_diamond_bonus_* the live round openers
 *                           seal with, and the payout_version the live CHECK
 *                           constraints admit, vs the function the client's own
 *                           source says it mirrors and the payout_version
 *                           unions it declares
 *
 * Neither side is a hand-maintained list. The live side is `pg_get_functiondef`
 * and the live model functions EXECUTED read-only; the client side is parsed out
 * of the client's own type unions and assertions. If the client stops declaring
 * them, this exits 2 (COULD NOT TELL) rather than passing - a guard whose
 * subject was refactored away must say so, not go quiet.
 *
 * ── TWO MODES, BECAUSE A PULL REQUEST CANNOT SEE PRODUCTION ────────────────
 *
 * `--source` (the default, and what ci.yml runs). No database. It answers the
 * question a pull request CAN answer with certainty, in both directions:
 *
 *   FORWARD   a migration in this branch that moves a Diamond Spins contract
 *             cannot merge unless the client in the SAME branch accepts the
 *             value it introduces.
 *   BACKWARD  the client in this branch cannot DROP a contract value it used
 *             to accept unless a migration in the same branch retires it
 *             server-side. Dropping it alone would leave main unable to read a
 *             contract production is still speaking.
 *
 * This runs on every pull request and on ci.yml's daily main schedule. It never
 * needs a credential, so pull-request checks do not depend on production being
 * reachable - the same ruling the estate already made for the live readers in
 * production-integrity-audit.yml.
 *
 * `--live` (what Production Integrity Audit runs, hourly). The definitive half:
 * it reads production read-only and compares it against the client on the
 * checked-out tree. This is the half that catches the failure that has no pull
 * request at all - a migration applied straight to production, which is exactly
 * what happened on 2026-09-23 and is the estate's normal way of shipping
 * schema. There is no cache and no fixture in this path: every fact comes from
 * `pg_get_functiondef`, `pg_get_constraintdef`, `pg_proc.prosrc` or from
 * executing the live, read-only model function. A credential that is present
 * but unreadable is exit 2, never a pass (CLAUDE.md 10.86 rule 2). This script
 * never contains, derives, prints or writes a credential (10.84): every error
 * string is scrubbed of the connection string before it reaches the log.
 *
 * Usage:  node scripts/ci/check-diamond-contract-parity.mjs [--source|--live] [baseRef]
 * Exit:   0 the two agree · 1 they disagree · 2 could not tell
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = '[diamond-contract-parity]';

/** The client files that DECLARE what the client can read. Each one is named
 *  in every message this check prints, because the remedy is always in one of
 *  them. */
export const CLIENT_FILES = {
  service: 'src/services/DiamondWheelService.ts',
  award: 'src/utils/wheelAward.ts',
  floor: 'src/utils/diamondBonusPayout.ts',
  receipts: [
    'src/services/DiamondBonusService.ts',
    'src/services/DiamondChoiceService.ts',
    'src/services/DiamondGamesService.ts',
  ],
};

/** The live functions that OPEN a bonus round, and therefore choose the floor
 *  rule every new receipt is sealed with. A round that is already sealed keeps
 *  the rule it was sealed under, so the resolvers are deliberately not here. */
export const LIVE_ROUND_OPENERS = [
  'fn_crash_start',
  'fn_choice_start',
  'fn_plinko_bonus_run',
  'fn_wheel_bonus_start',
];

/** The tables whose CHECK constraints declare the receipt version production
 *  will admit. */
export const LIVE_RECEIPT_TABLES = ['public.crash_rounds', 'public.diamond_choice_rounds'];

/** A question this check could not answer. Never folded into "they agree". */
export class CannotTell extends Error {}

const die = (msg) => {
  console.error(`${TAG} COULD NOT TELL.`);
  for (const line of String(msg).split('\n')) console.error(`   ${line}`);
  console.error('   An answer that could not be read is not a good answer. This is not a pass.');
  process.exit(2);
};

/* ───────────────────────────── the client side ─────────────────────────────
 * Parsed out of the client's own declarations. Every parser throws CannotTell
 * when the declaration it reads is gone, so a refactor that moves the accepted
 * set somewhere else turns this check amber and not green.
 * ------------------------------------------------------------------------ */

/** Comments are stripped only inside the small region being read, so a URL in
 *  a string elsewhere in the file can never be mangled into a false member. */
function withoutComments(region) {
  return region.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** `export type X = 'a' | 'b';` or `export type X = 2 | 3;` -> its members. */
export function typeUnion(src, name, where) {
  const m = new RegExp(`export\\s+type\\s+${name}\\s*=([\\s\\S]*?);`).exec(src);
  if (!m)
    throw new CannotTell(
      `${where} no longer declares "export type ${name}". That union IS the ` +
        `client's accepted set; without it nothing here can tell what the client can read.`
    );
  const body = withoutComments(m[1]);
  const members = [...body.matchAll(/'([^']*)'|(-?\d+(?:\.\d+)?)/g)].map((x) =>
    x[1] !== undefined ? x[1] : Number(x[2])
  );
  if (members.length === 0)
    throw new CannotTell(`${where}: "export type ${name}" declares no literal members.`);
  return members;
}

/** The exact length `assertWheelAward` / `assertWheelUpgradeTable` refuse to
 *  accept anything but. It is written as `table.length !== 12`. */
export function declaredSegmentCount(src, fnName, where) {
  const at = src.indexOf(`export function ${fnName}`);
  if (at === -1)
    throw new CannotTell(`${where} no longer exports ${fnName}; the segment count is unreadable.`);
  const m = /table\??\.length\s*!==\s*(\d+)/.exec(withoutComments(src.slice(at)));
  if (!m)
    throw new CannotTell(
      `${where}: ${fnName} no longer pins a segment count (\`table.length !== <n>\`).`
    );
  return Number(m[1]);
}

/** The estate's own convention: a client mirror of a server rule says which
 *  server function it mirrors, in its doc comment. src/utils/clubLevels.ts,
 *  src/utils/diamondChoiceMath.ts and src/utils/diamondBonusPayout.ts all do
 *  it. That declaration is what makes "which floor rule does the client
 *  implement" a readable fact instead of a guess about arithmetic. */
export function declaredMirror(src, exportName, where) {
  const at = src.indexOf(`export function ${exportName}`);
  if (at === -1)
    throw new CannotTell(`${where} no longer exports ${exportName}; the floor rule is unreadable.`);
  const all = [...src.slice(0, at).matchAll(/[Mm]irrors\s+public\.(fn_[a-z0-9_]+)\s*\(([^)]*)\)/g)];
  if (all.length === 0)
    throw new CannotTell(
      `${where}: ${exportName} no longer declares "Mirrors public.fn_<name>(...)" above it. ` +
        `That line is how this check knows which live rule the client implements.`
    );
  const last = all[all.length - 1];
  return {
    fn: last[1],
    params: last[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Every `payout_version?: 1 | 2 | 3;` the receipt types declare, unioned. */
export function declaredPayoutVersions(read) {
  const out = new Set();
  for (const file of CLIENT_FILES.receipts) {
    const src = read(file);
    if (src === null) continue;
    for (const m of src.matchAll(/payout_version\??\s*:\s*([0-9|\s]+);/g))
      for (const n of m[1].matchAll(/\d+/g)) out.add(Number(n[0]));
  }
  if (out.size === 0)
    throw new CannotTell(
      `none of ${CLIENT_FILES.receipts.join(', ')} declares a payout_version union any more; ` +
        `the receipt versions the client can read are unreadable.`
    );
  return [...out].sort((a, b) => a - b);
}

/**
 * WHAT THE CLIENT ON THIS TREE CAN READ.
 * `read(path)` returns the file's text, or null when it does not exist.
 */
export function clientContract(read) {
  const must = (p) => {
    const src = read(p);
    if (src === null) throw new CannotTell(`${p} is missing; the client's accepted set is unreadable.`);
    return src;
  };
  const service = must(CLIENT_FILES.service);
  const award = must(CLIENT_FILES.award);
  const floor = must(CLIENT_FILES.floor);
  const domains = typeUnion(service, 'WheelDrawDomain', CLIENT_FILES.service).map(String);
  return {
    contract_versions: typeUnion(service, 'WheelContractVersion', CLIENT_FILES.service)
      .map(Number)
      .sort((a, b) => a - b),
    draw_domains: [...new Set(domains)].sort(),
    /* 'wheel-v3-upgrade' is the SAME model as 'wheel-v3': one draw, one
       secondary draw. The model the server names is the prefix. */
    model_versions: [...new Set(domains.map((d) => d.replace(/-upgrade$/, '')))].sort(),
    prize_kinds: [...new Set(typeUnion(service, 'WheelSegmentKind', CLIENT_FILES.service).map(String))].sort(),
    bonus_games: [...new Set(typeUnion(service, 'WheelBonusGame', CLIENT_FILES.service).map(String))].sort(),
    segment_count: declaredSegmentCount(award, 'assertWheelAward', CLIENT_FILES.award),
    upgrade_segment_count: declaredSegmentCount(award, 'assertWheelUpgradeTable', CLIENT_FILES.award),
    bonus_floor_fn: declaredMirror(floor, 'diamondBonusMinimum', CLIENT_FILES.floor).fn,
    payout_versions: declaredPayoutVersions(read),
  };
}

/* ────────────────────────────── the live side ──────────────────────────────
 * Read-only. Three catalog reads and one execution of the live, STABLE model
 * function. No DDL, no writes, no cache, no fixture.
 * ------------------------------------------------------------------------ */

/** Nothing this script prints may carry a credential (CLAUDE.md 10.84). psql
 *  echoes the conninfo it was handed in several of its own error messages, so
 *  every byte on its way to the log goes through here first. */
export function scrub(text) {
  let s = String(text ?? '');
  for (const v of [process.env.SUPABASE_DB_URL, process.env.DATABASE_URL, process.env.PGPASSWORD])
    if (v) s = s.split(v).join('<connection string>');
  return s
    .replace(/(password\s*=\s*)\S+/gi, '$1<redacted>')
    .replace(/:\/\/([^:@/\s]+):[^@\s]+@/g, '://$1:<redacted>@');
}

function ask(sql) {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  if (!url)
    die(
      'no SUPABASE_DB_URL / DATABASE_URL in the environment, so production was never asked.\n' +
        'Run this from Production Integrity Audit, which carries the read-only credential.'
    );
  try {
    return execFileSync(process.env.PSQL_BIN || 'psql', [url, '-X', '-At', '-c', sql], {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGCONNECT_TIMEOUT: '15' },
    });
  } catch (err) {
    die(`COULD NOT ASK THE DATABASE.\n${scrub(err?.stderr || err?.message || err).trim()}`);
  }
}

const rows = (out) =>
  String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const all = (text, re, cast = String) => [...String(text).matchAll(re)].map((m) => cast(m[1]));
const uniq = (xs) => [...new Set(xs)];

/** The literal arguments the live segments function is called with. Named
 *  notation, so a signature that gains or loses a parameter is noticed rather
 *  than silently mis-positioned. An entry (25 diamonds) and a bridge rate of
 *  100 are inside every bound fn_wheel_state_v2 itself enforces. */
const SEGMENT_ARG_VALUES = {
  primary: { p_entry: '100', p_rate: '100', p_secondary: 'false', p_vip: 'false' },
  primary_vip: { p_entry: '100', p_rate: '100', p_secondary: 'false', p_vip: 'true' },
  upgrade: { p_entry: '100', p_rate: '100', p_secondary: 'true', p_vip: 'false' },
};

function segmentsCall(fn, argNames, variant) {
  const values = SEGMENT_ARG_VALUES[variant];
  const args = argNames.map((name) => {
    if (!(name in values))
      throw new CannotTell(
        `public.${fn} takes a parameter this check has never seen (${name}). ` +
          `It cannot be executed safely without knowing what to pass; teach ` +
          `SEGMENT_ARG_VALUES about it in the same change that added it.`
      );
    return `${name} => ${values[name]}`;
  });
  return `public.${fn}(${args.join(',')})`;
}

/**
 * WHAT PRODUCTION SPEAKS, right now.
 * `askFn(sql)` returns psql's raw stdout; injected so the law test can drive
 * this with recorded catalog text without ever pretending it asked production.
 */
export function liveContract(askFn) {
  const n = Number(
    rows(
      askFn(
        `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ` +
          `WHERE n.nspname='public' AND p.proname='fn_wheel_state_v2'`
      )
    )[0]
  );
  if (n !== 1)
    throw new CannotTell(
      `public.fn_wheel_state_v2 resolves to ${n} functions in the live catalog, not one. ` +
        `The wheel door has to be one function for its answer to be one contract.`
    );

  const def = askFn(
    `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ` +
      `WHERE n.nspname='public' AND p.proname='fn_wheel_state_v2'`
  );
  const contract_versions = uniq(all(def, /'contract_version'\s*,\s*(\d+)/g, Number)).sort((a, b) => a - b);
  const model_versions = uniq(all(def, /'model_version'\s*,\s*'([^']+)'/g)).sort();
  const segments_fns = uniq(all(def, /public\.(fn_wheel_v\d+_segments)\s*\(/g)).sort();
  if (!contract_versions.length || !model_versions.length || !segments_fns.length)
    throw new CannotTell(
      `the live fn_wheel_state_v2 no longer names a contract_version, a model_version and a ` +
        `segments function in its own body. This check reads that body; it cannot read a rewrite of it.`
    );
  if (segments_fns.length !== 1)
    throw new CannotTell(
      `the live fn_wheel_state_v2 calls ${segments_fns.length} different segments functions ` +
        `(${segments_fns.join(', ')}); which one is the contract is not decidable here.`
    );
  const segments_fn = segments_fns[0];

  const argNames = rows(
    askFn(
      `SELECT COALESCE(array_to_string(p.proargnames,','),'') FROM pg_proc p ` +
        `JOIN pg_namespace n ON n.oid=p.pronamespace ` +
        `WHERE n.nspname='public' AND p.proname='${segments_fn}'`
    )
  );
  if (argNames.length !== 1 || !argNames[0])
    throw new CannotTell(`public.${segments_fn} does not resolve to exactly one named signature.`);
  const names = argNames[0].split(',').filter(Boolean);

  const shapeSql = Object.keys(SEGMENT_ARG_VALUES)
    .map((variant) => {
      const call = segmentsCall(segments_fn, names, variant);
      return (
        `SELECT '${variant}'||E'\\t'||jsonb_array_length(s)||E'\\t'||` +
        `COALESCE((SELECT string_agg(k,',') FROM (SELECT DISTINCT e->>'kind' k FROM jsonb_array_elements(s) e ORDER BY 1) q),'')||E'\\t'||` +
        `COALESCE((SELECT string_agg(g,',') FROM (SELECT DISTINCT e->>'game' g FROM jsonb_array_elements(s) e WHERE e->>'game' IS NOT NULL ORDER BY 1) q),'') ` +
        `FROM (SELECT ${call} AS s) t`
      );
    })
    .join(' UNION ALL ');
  const shape = {};
  for (const line of rows(askFn(shapeSql))) {
    const [variant, count, kinds, games] = line.split('\t');
    shape[variant] = {
      count: Number(count),
      kinds: kinds ? kinds.split(',') : [],
      games: games ? games.split(',') : [],
    };
  }
  for (const variant of Object.keys(SEGMENT_ARG_VALUES))
    if (!shape[variant] || !Number.isInteger(shape[variant].count))
      throw new CannotTell(`public.${segments_fn} produced no ${variant} table to measure.`);

  const floorRefs = rows(
    askFn(
      `SELECT p.proname||E'\\t'||m[1] FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, ` +
        `LATERAL regexp_matches(p.prosrc,'fn_diamond_bonus_[a-z_]+','g') m ` +
        `WHERE n.nspname='public' AND p.proname IN (${LIVE_ROUND_OPENERS.map((f) => `'${f}'`).join(',')})`
    )
  ).map((l) => l.split('\t'));
  const bonus_floor_fns = uniq(floorRefs.map(([, fn]) => fn)).sort();
  if (!bonus_floor_fns.length)
    throw new CannotTell(
      `no live round opener (${LIVE_ROUND_OPENERS.join(', ')}) references a fn_diamond_bonus_* ` +
        `floor function. The rule moved somewhere this check does not read.`
    );

  const constraints = rows(
    askFn(
      `SELECT c.conrelid::regclass::text||E'\\t'||pg_get_constraintdef(c.oid) FROM pg_constraint c ` +
        `WHERE c.conrelid = ANY (ARRAY[${LIVE_RECEIPT_TABLES.map((t) => `to_regclass('${t}')`).join(',')}]::oid[]) ` +
        `AND pg_get_constraintdef(c.oid) ILIKE '%payout_version%'`
    )
  );
  const floors = constraints.flatMap((l) => all(l, /payout_version\s*>=\s*(\d+)/g, Number));
  /* psql hands back "<table>\t<constraintdef>"; a raw tab in a one-sentence
     verdict reads as a formatting bug, so it is spelled out here. */
  const receipt_constraints = constraints.map((l) => l.replace('\t', ' '));
  return {
    contract_versions,
    model_versions,
    segments_fn,
    segment_count: shape.primary.count,
    upgrade_segment_count: shape.upgrade.count,
    prize_kinds: uniq([...shape.primary.kinds, ...shape.primary_vip.kinds, ...shape.upgrade.kinds]).sort(),
    bonus_games: uniq([...shape.primary.games, ...shape.primary_vip.games, ...shape.upgrade.games]).sort(),
    bonus_floor_fns,
    /* The lowest receipt version production will still admit. null when no
       table declares one, which is a real answer and not an unknown. */
    min_payout_version: floors.length ? Math.max(...floors) : null,
    receipt_constraints,
  };
}

/* ───────────────────────── live vs client, one sentence ─────────────────── */

const list = (xs) => (xs.length ? xs.join(', ') : 'nothing');

/**
 * EVERY CONTRACT PRODUCTION SPEAKS MUST BE ONE THE CLIENT CAN READ.
 *
 * One direction is enough for both halves of the rule. A migration that moves
 * the contract forward makes production speak a value the client does not
 * accept; a client that drops support for a value makes production speak a
 * value the client no longer accepts. Both land here.
 *
 * Each entry is one sentence a human can act on without opening anything else.
 */
export function disagreements(live, client) {
  const out = [];
  const missing = (a, b) => a.filter((v) => !b.includes(v));

  const cv = missing(live.contract_versions, client.contract_versions);
  if (cv.length)
    out.push(
      `the live fn_wheel_state_v2 returns contract_version ${list(cv)}, and the client accepts only ` +
        `${list(client.contract_versions)} (WheelContractVersion in ${CLIENT_FILES.service}), so every ` +
        `wheel load throws before it paints.`
    );

  const mv = missing(live.model_versions, client.model_versions);
  if (mv.length)
    out.push(
      `the live fn_wheel_state_v2 names model_version ${list(mv)}, and the client accepts only the draw ` +
        `domains ${list(client.draw_domains)} (WheelDrawDomain in ${CLIENT_FILES.service}), so the ` +
        `fairness proof on every receipt is refused.`
    );

  const kinds = missing(live.prize_kinds, client.prize_kinds);
  if (kinds.length)
    out.push(
      `the live ${live.segments_fn} puts prize kind ${list(kinds)} on the wheel and the client's ` +
        `WheelSegmentKind in ${CLIENT_FILES.service} does not list it, so that segment is unrenderable.`
    );

  const games = missing(live.bonus_games, client.bonus_games);
  if (games.length)
    out.push(
      `the live ${live.segments_fn} offers bonus game ${list(games)} and the client's WheelBonusGame in ` +
        `${CLIENT_FILES.service} does not list it, so landing on it has nowhere to go.`
    );

  if (live.segment_count !== client.segment_count)
    out.push(
      `the live ${live.segments_fn} returns ${live.segment_count} segments and assertWheelAward in ` +
        `${CLIENT_FILES.award} refuses any table that is not ${client.segment_count}, so every spin ` +
        `receipt is rejected.`
    );

  if (live.upgrade_segment_count !== client.upgrade_segment_count)
    out.push(
      `the live ${live.segments_fn} returns ${live.upgrade_segment_count} upgrade segments and ` +
        `assertWheelUpgradeTable in ${CLIENT_FILES.award} refuses any table that is not ` +
        `${client.upgrade_segment_count}, so the Upgrade draw is rejected.`
    );

  if (!live.bonus_floor_fns.includes(client.bonus_floor_fn))
    out.push(
      `no live round opener reaches for public.${client.bonus_floor_fn} any more - they seal against ` +
        `${list(live.bonus_floor_fns.map((f) => `public.${f}`))} - and ${CLIENT_FILES.floor} still declares ` +
        `that it mirrors public.${client.bonus_floor_fn}, so the guaranteed minimum the page shows is ` +
        `computed from a rule production stopped using.`
    );

  const topClientReceipt = Math.max(...client.payout_versions);
  if (live.min_payout_version !== null && live.min_payout_version > topClientReceipt)
    out.push(
      `production will only admit payout_version >= ${live.min_payout_version} ` +
        `(${list(live.receipt_constraints)}) and the client reads at most ${topClientReceipt} ` +
        `(the payout_version unions in ${CLIENT_FILES.receipts.join(', ')}), so every new bonus receipt ` +
        `fails validation.`
    );

  return out;
}

/* ───────────────────────── the source-only half (ci.yml) ────────────────── */

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The commit this branch grew from, exactly as check-migrations-applied.mjs
 *  decides it: PRs get it from GitHub, a push compares against its own parent. */
export function baseRef(argv = process.argv.slice(2)) {
  const explicit = argv.find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  const b = process.env.GITHUB_BASE_REF;
  if (b)
    for (const ref of [`origin/${b}`, b]) {
      try {
        git(['rev-parse', '--verify', ref]);
        return ref;
      } catch {
        /* try the next spelling */
      }
    }
  return 'HEAD~1';
}

/**
 * THE MIGRATION, CUT INTO THE FUNCTIONS IT DECLARES.
 *
 * Harvesting contract facts from the whole file is what makes a gate that
 * accuses at a rate nobody tolerates. Measured across the 3,292 migrations on
 * main, a whole-file parser claimed a Diamond Spins contract fact in fourteen
 * of them, and SEVEN were false: `stats_v2_foundation` and three siblings
 * build `jsonb_build_object('contract_version',2,...)` for the STATS contract,
 * which has nothing to do with the wheel; and `fn_diamond_bonus_start`,
 * `_state`, `_latest`, `_immutable`, `_replay`, `_share` and
 * `_spin_ticket_guard` are not floor rules, they are the bonus lifecycle.
 * CLAUDE.md is explicit about what a gate with that hit rate becomes: switched
 * off. So a fact counts only where it is declared.
 */
export function functionChunks(sql) {
  const text = String(sql);
  const marks = [
    ...text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?[a-z0-9_]+"?\s*\.\s*)?"?([a-z0-9_]+)"?/gi),
  ].map((m) => ({ name: m[1].toLowerCase(), start: m.index }));
  return marks.map((m, i) => ({
    name: m.name,
    text: text.slice(m.start, i + 1 < marks.length ? marks[i + 1].start : text.length),
  }));
}

/**
 * WHAT A MIGRATION DECLARES ABOUT THE DIAMOND SPINS CONTRACT.
 *
 * Comments and string bodies are left intact on purpose: a migration states
 * its contract INSIDE a dollar-quoted function body, which is the one place a
 * comment-stripping parser would throw it away.
 */
export function contractFactsInSql(sql) {
  const text = String(sql);
  const chunks = functionChunks(text);
  const wheel = chunks.filter((c) => c.name.startsWith('fn_wheel_')).map((c) => c.text).join('\n');
  /* A receipt version only means this contract where a Diamond Spins round is
     the subject. `payout_version` is a column name a tournament could reuse. */
  const receipts = /\b(crash_rounds|diamond_choice_rounds|wheel_bonus_awards|fn_diamond_bonus_|fn_plinko_bonus_)/i.test(text)
    ? text
    : '';
  return {
    contract_versions: uniq(all(wheel, /'contract_version'\s*,\s*(\d+)/g, Number)).sort((a, b) => a - b),
    model_versions: uniq(all(wheel, /'model_version'\s*,\s*'([^']+)'/g)).sort(),
    /* fn_wheel_v4_segments / fn_wheel_v4_model name the generation directly. */
    model_generations: uniq(all(wheel, /fn_wheel_v(\d+)_(?:segments|model)\b/g, Number)).sort((a, b) => a - b),
    payout_versions: uniq(all(receipts, /payout_version\s*(?:>=|=)\s*(\d+)/g, Number)).sort((a, b) => a - b),
    /* Every bonus function this migration CREATES. On its own this says
       nothing - the family is the whole bonus lifecycle - so the verdict pairs
       it with whether the migration also NAMES the rule the client mirrors.
       A migration that installs a new bonus function where the client's rule
       is today is moving the floor; a migration that merely adds a sibling is
       not. Measured over all 3,292 migrations on main, that pair accuses
       none of them, and it catches 20260923033010, which moves the openers
       off fn_diamond_bonus_minimum by rewriting their bodies in place rather
       than by any CREATE this parser could have seen. */
    declared_bonus_fns: uniq(
      all(text, /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(fn_diamond_bonus_[a-z_]+)/gi, (x) =>
        x.toLowerCase()
      )
    ).sort(),
  };
}

function changedMigrations(base) {
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  } catch {
    try {
      out = git(['diff', '--name-only', '--diff-filter=AM', base, 'HEAD']);
    } catch {
      die(
        `cannot diff against "${base}" - the checkout is probably shallow.\n` +
          `Give the job fetch-depth: 0, or pass an explicit base ref.`
      );
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('supabase/migrations/') && l.endsWith('.sql'));
}

const readHead = (p) => {
  const full = join(REPO, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
};
const readAt = (ref) => (p) => {
  try {
    return git(['show', `${ref}:${p}`]);
  } catch {
    return null;
  }
};

/**
 * THE FORWARD RULE AND THE BACKWARD RULE, both decidable from the branch alone.
 *
 * FORWARD: a migration here that moves a contract must land with a client that
 *   accepts the value it introduces. This is the failure of 2026-09-23 caught
 *   at the only moment a pull request can catch it.
 * BACKWARD: a client here that stops accepting a value must land with the
 *   migration that retires it server-side. Dropping it alone leaves main unable
 *   to read a contract production is still speaking, which is the same outage
 *   from the other end.
 */
export function sourceVerdict(base, head, migrations) {
  const problems = [];
  const facts = migrations.map(({ file, sql }) => ({ file, sql: String(sql), facts: contractFactsInSql(sql) }));

  for (const { file, sql, facts: f } of facts) {
    const unreadable = (vals, accepted) => vals.filter((v) => !accepted.includes(v));

    for (const v of unreadable(f.contract_versions, head.contract_versions))
      problems.push(
        `${file} makes the server return contract_version ${v}, and the client in this branch accepts ` +
          `only ${list(head.contract_versions)}. Widen WheelContractVersion in ${CLIENT_FILES.service} ` +
          `in this same branch, or the wheel goes dead the moment this is applied.`
      );
    for (const v of unreadable(f.model_versions, head.model_versions))
      problems.push(
        `${file} makes the server name model_version '${v}', and the client in this branch accepts only ` +
          `${list(head.draw_domains)}. Add '${v}' and '${v}-upgrade' to WheelDrawDomain in ` +
          `${CLIENT_FILES.service} in this same branch.`
      );
    for (const g of unreadable(f.model_generations.map((n) => `wheel-v${n}`), head.model_versions))
      problems.push(
        `${file} builds the wheel from the ${g} model, and the client in this branch accepts only ` +
          `${list(head.model_versions)}. Add '${g}' to WheelDrawDomain in ${CLIENT_FILES.service} ` +
          `in this same branch.`
      );
    for (const v of unreadable(f.payout_versions, head.payout_versions))
      problems.push(
        `${file} seals bonus receipts at payout_version ${v}, and the client in this branch reads only ` +
          `${list(head.payout_versions)}. Widen the payout_version unions in ` +
          `${CLIENT_FILES.receipts.join(', ')} in this same branch.`
      );
    const moved = f.declared_bonus_fns.filter((n) => n !== head.bonus_floor_fn);
    if (moved.length && sql.includes(head.bonus_floor_fn))
      problems.push(
        `${file} installs ${list(moved.map((x) => `public.${x}`))} where public.${head.bonus_floor_fn} is ` +
          `today, and ${CLIENT_FILES.floor} still says it mirrors public.${head.bonus_floor_fn}. Move the ` +
          `client's mirror onto the rule this branch seals with, or the page shows a minimum production ` +
          `will not pay.`
      );
  }

  /* BACKWARD. A value the client used to accept and no longer does needs a
     migration in this same branch that names it - otherwise nothing has told
     production to stop speaking it. */
  const retiredBy = (needle) =>
    migrations.filter(({ sql }) => String(sql).includes(String(needle))).map(({ file }) => file);
  const narrowings = [
    ['contract version', base.contract_versions, head.contract_versions, (v) => `'contract_version',${v}`, CLIENT_FILES.service],
    ['draw domain', base.draw_domains, head.draw_domains, (v) => v.replace(/-upgrade$/, ''), CLIENT_FILES.service],
    ['prize kind', base.prize_kinds, head.prize_kinds, (v) => v, CLIENT_FILES.service],
    ['bonus game', base.bonus_games, head.bonus_games, (v) => v, CLIENT_FILES.service],
    ['receipt payout_version', base.payout_versions, head.payout_versions, (v) => `payout_version`, CLIENT_FILES.receipts.join(', ')],
  ];
  for (const [label, was, now, needleOf, where] of narrowings)
    for (const v of was.filter((x) => !now.includes(x)))
      if (retiredBy(needleOf(v)).length === 0)
        problems.push(
          `this branch drops ${label} ${JSON.stringify(v)} from ${where} and carries no migration that ` +
            `retires it, so production may still be speaking it. Land the migration that retires it in ` +
            `this same branch, or keep reading it.`
        );

  if (
    base.bonus_floor_fn !== head.bonus_floor_fn &&
    !migrations.some(({ sql }) => String(sql).includes(head.bonus_floor_fn))
  )
    problems.push(
      `this branch moves ${CLIENT_FILES.floor} onto public.${head.bonus_floor_fn} and carries no ` +
        `migration that declares it, so the client would mirror a rule production does not have.`
    );

  for (const [label, was, now] of [
    ['segments', base.segment_count, head.segment_count],
    ['upgrade segments', base.upgrade_segment_count, head.upgrade_segment_count],
  ])
    if (was !== now && facts.every(({ facts: f }) => f.model_generations.length === 0))
      problems.push(
        `this branch changes the accepted ${label} count from ${was} to ${now} in ${CLIENT_FILES.award} ` +
          `and carries no migration that rebuilds the wheel model, so it is asserting a shape production ` +
          `was never told about.`
      );

  return problems;
}

function report(title, client, extra = []) {
  console.log(`${TAG} ${title}`);
  console.log(`   client accepts: contract_version ${list(client.contract_versions)} | draw domains ` +
    `${list(client.draw_domains)} | ${client.segment_count} segments (+${client.upgrade_segment_count} upgrade) | ` +
    `kinds ${list(client.prize_kinds)} | floor public.${client.bonus_floor_fn} | payout_version ` +
    `${list(client.payout_versions)}`);
  for (const line of extra) console.log(`   ${line}`);
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--live') ? 'live' : 'source';

  let client;
  try {
    client = clientContract(readHead);
  } catch (err) {
    if (err instanceof CannotTell) die(err.message);
    throw err;
  }

  if (mode === 'live') {
    let live;
    try {
      live = liveContract(ask);
    } catch (err) {
      if (err instanceof CannotTell) die(err.message);
      throw err;
    }
    const problems = disagreements(live, client);
    report('asked production directly (read-only).', client, [
      `production speaks: contract_version ${list(live.contract_versions)} | model_version ` +
        `${list(live.model_versions)} | ${live.segment_count} segments (+${live.upgrade_segment_count} upgrade) ` +
        `from public.${live.segments_fn} | kinds ${list(live.prize_kinds)} | floor ` +
        `${list(live.bonus_floor_fns.map((f) => `public.${f}`))} | payout_version >= ` +
        `${live.min_payout_version === null ? 'unconstrained' : live.min_payout_version}`,
    ]);
    if (!problems.length) {
      console.log(`${TAG} OK - production and the client on this tree speak the same Diamond Spins contract.`);
      return;
    }
    console.error('');
    console.error(`${TAG} DIAMOND SPINS CONTRACT DRIFT - production is speaking a contract this client cannot read.`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('   Land the client that matches, or revert the migration. Until one of those happens the');
    console.error('   wheel is dead for every player on the deployed build.');
    process.exit(1);
  }

  const base = baseRef(argv);
  const files = changedMigrations(base);
  const migrations = files
    .map((file) => ({ file, sql: readHead(file) }))
    .filter(({ sql }) => sql !== null);

  let baseClient;
  try {
    baseClient = clientContract(readAt(base));
  } catch (err) {
    if (err instanceof CannotTell)
      die(`${err.message}\n(reading the client as it stands on ${base})`);
    throw err;
  }

  const problems = sourceVerdict(baseClient, client, migrations);
  report(
    `${migrations.length} changed migration(s) against ${base}; no database was asked.`,
    client
  );
  if (!problems.length) {
    console.log(
      `${TAG} OK - nothing in this branch moves a Diamond Spins contract past the client in it.`
    );
    console.log(
      `${TAG} The live comparison is the hourly one in Production Integrity Audit; this half cannot see`
    );
    console.log(`${TAG} a migration applied straight to production, and never claims to.`);
    return;
  }
  console.error('');
  console.error(`${TAG} DIAMOND SPINS CONTRACT DRIFT - this branch would leave main unable to read production.`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

/* REAL PATHS ON BOTH SIDES. The usual spelling of this guard compares
   import.meta.url against process.argv[1] as given, and those differ whenever
   the invocation path crosses a symlink - on macOS `/tmp` is a symlink to
   `/private/tmp`, so running this out of a scratch directory made the whole
   script exit 0 having done nothing at all. A check that silently declines to
   run is the exact failure this file exists to stop. */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
