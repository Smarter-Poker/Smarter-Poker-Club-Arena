/**
 * LIGHTNING 2.0 PHASE 4 REMEDIATION: A THRESHOLD READER THAT NEVER RAISES, A
 * VERDICT THAT CAN SEE THE PENDING STATES, AND ONE PLAN INSTEAD OF THREE.
 *
 * 20260921064717 shipped a configuration reader whose GUARD and whose CAST
 * admit different sets. It guarded with `jsonb_typeof(...) = 'number'`, which
 * admits every JSON number, and coerced with `::integer`, which accepts only
 * int4. Everything in the gap raised:
 *
 *   {"on_threshold": 18.5}        22P02  invalid input syntax for integer
 *   {"on_threshold": 18.0}        22P02  invalid input syntax for integer
 *   {"on_threshold": 2147483648}  22003  out of range for type integer
 *   {"on_threshold": 1e300}       22003  out of range for type integer
 *
 * 18.0 is the one that mattered: jsonb keeps the trailing zero, to_jsonb(numeric)
 * produces it, and any serialiser that does not special-case whole floats
 * produces it. The error did not stop at the reader - it travelled up through
 * fn_cash_cluster_lightning_state into fn_cash_game_lobby, which is SECURITY
 * DEFINER, granted to authenticated, and polled every five seconds while the
 * modal is open. One badly typed configuration value would have 500'd every
 * lobby open for that Cluster, for every player, until somebody edited jsonb by
 * hand. Armed, not detonated: 0 of 166 Clusters carry
 * `ruleset_snapshot -> 'lightning'` today, and it arms the moment anyone uses
 * the mechanism the feature exists to provide.
 *
 * THE THING THAT MAKES THIS FILE WORTH WRITING IS THAT THE OLD SOURCE TEST WAS
 * GREEN THROUGHOUT. tests/lightning-phase-4-population.test.ts asserted
 * `not.toContain('RAISE EXCEPTION')` over the body - and the raise came from a
 * CAST, not from a RAISE statement. An absence assertion that cannot name the
 * mechanism it refuses proves nothing at all. So nothing here asserts an
 * absence without also asserting the presence that makes the absence mean
 * something, and the guard/cast pin is stated as a PAIR: the set the guard
 * admits and the set the cast accepts must be the same set.
 *
 * Three repairs, and this file pins all three:
 *
 *   1. THE RULE BECOMES A PURE FUNCTION. fn_cash_cluster_lightning_thresholds_probe
 *      takes a configuration and a handedness and returns the pair, so it can be
 *      fuzzed with any shape at all - from a @live-proof, against production,
 *      writing nothing. Its guard is one regex over the TEXT form,
 *      `^-?[0-9]{1,9}(\.0+)?$`, and its cast is floor(...::numeric)::integer.
 *      At most nine digits, so int4 cannot overflow; an optional run of
 *      trailing zeros, so 18.0 is accepted AS 18.
 *
 *   2. THE VERDICT ANSWERS IN THE PENDING STATES. The specification asks the
 *      same question twice on the way in and twice on the way out, and the
 *      second asking happens in a PENDING state by construction, so a verdict
 *      that only answers in must_move and lightning would abort every
 *      conversion at its own safety re-check. Both filters widen by one state.
 *
 *   3. THE READER COSTS ONE PLAN. Both children carry SET search_path and
 *      therefore cannot be inlined, so the sql-language shape planned three
 *      levels per call: 3.746 ms against children of 0.151 ms, 24% of a 15.6 ms
 *      lobby open. LANGUAGE plpgsql caches its statement plans per session.
 *
 * AND ONE RULE ABOUT PROSE. Three proofs in this project have already gone
 * false purely because the body they read quoted, IN A COMMENT, the very string
 * they forbade. Every text pin here is taken against CODE - comments stripped -
 * and the two that could still be satisfied by a string LITERAL are taken
 * against BIZ, with the literals blanked too. Both strips are proven to be
 * doing work rather than assumed to be: the assertions that would be FALSE
 * without them are stated in both directions.
 *
 * LIGHTNING_P4R_MIGRATION overrides the file under test, so mutation testing -
 * copying the migration to a scratch directory, breaking one line of the copy
 * and watching this suite go red - never has to touch the migration in the
 * repository. It is the same mechanism its siblings take as
 * LIGHTNING_P3R_MIGRATION and LIGHTNING_P4_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql';
const MIGRATION = process.env.LIGHTNING_P4R_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');

/** Comment-stripped, so no pin below can be satisfied by the header's prose. */
const CODE = SQL.replace(/--[^\n]*/g, '');

/**
 * Comment-stripped AND string-literal-blanked, keeping every offset. The
 * COMMENT ON bodies and the RAISE messages are prose that happens to sit inside
 * quotes - the probe's own COMMENT says it was "granted to authenticated", which
 * is a sentence about a defect and not a grant - and a rule that forbade a
 * GRANT to the browser would match that sentence if it read CODE alone.
 */
const blankLiterals = (s: string): string =>
  s.replace(/'(?:''|[^'])*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
const BIZ = blankLiterals(CODE);

/** One span of text, from an anchor to the end of its terminator. '' if absent. */
function span(hay: string, from: string, to: string): string {
  const a = hay.indexOf(from);
  if (a < 0) return '';
  const b = hay.indexOf(to, a + from.length);
  return b < 0 ? '' : hay.slice(a, b + to.length);
}

/** Whitespace-normalised: one space per run, ends trimmed. */
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

const count = (hay: string, re: RegExp): number => (hay.match(re) ?? []).length;

/**
 * EVERY FUNCTION THIS FILE WRITES OUT, DISCOVERED RATHER THAN LISTED. The grant
 * completeness check below is driven off this, so a fourth function added to
 * this migration later cannot slip past ungranted by simply not being in a list
 * somebody remembered to extend. `attrs` is everything between RETURNS and the
 * dollar-quoted body - the return type, the language, the volatility, the
 * security attribute and the search_path - and `argTypes` is the signature as
 * REVOKE and GRANT have to spell it.
 */
const FUNCTIONS: { name: string; argTypes: string; attrs: string; body: string }[] = [
  ...CODE.matchAll(
    /CREATE OR REPLACE FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\4;/g
  ),
].map((m) => ({
  name: m[1],
  argTypes: m[2]
    .split(',')
    .map((a) =>
      flat(a)
        .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')
        .split(/\s+/)
        .slice(1)
        .join(' ')
    )
    .join(', '),
  attrs: flat(m[3]),
  body: m[5],
}));

const fnOf = (name: string) => {
  const f = FUNCTIONS.find((x) => x.name === name);
  if (!f) throw new Error(`the migration no longer writes out public.${name}`);
  return f;
};

/**
 * The keys of ONE jsonb_build_object, at its own nesting level only. Counting
 * every quoted token in the body would count the verdict's six keys as if they
 * were the reader's, and the point of the ten is that they are the shape
 * fn_cash_game_lobby embeds. Quoted literals are skipped whole, so a key
 * containing a comma or a parenthesis could not confuse the walk.
 */
const topKeys = (body: string): string[] => {
  const anchor = 'jsonb_build_object(';
  const at = body.indexOf(anchor);
  if (at < 0) return [];
  const keys: string[] = [];
  let depth = 1;
  let field = 0;
  let buf = '';
  for (let i = at + anchor.length; i < body.length && depth > 0; i++) {
    const c = body[i];
    if (c === "'") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "'" && body[j + 1] === "'") j += 2;
        else if (body[j] === "'") break;
        else j++;
      }
      buf += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(') {
      depth++;
      buf += c;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) break;
      buf += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      if (field === 0) keys.push(buf.trim().replace(/^'|'$/g, ''));
      field = 1 - field;
      buf = '';
      continue;
    }
    buf += c;
  }
  return keys;
};

/** Every @live-proof expression, in file order, and the raw lines they came from. */
const PROOF_LINES = SQL.split('\n').filter((l) => /^--\s*@live-proof:/.test(l));
const PROOFS = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);

/** Parentheses balance, with string literals blanked first so a `\(` inside a
 *  quoted regex cannot be read as structure. */
const balanced = (expr: string): boolean => {
  let depth = 0;
  for (const c of blankLiterals(expr)) {
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
};

/** One job of the workflow, from its key to the next thing at job indent. */
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobBlock = (name: string): string => {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
};

const PROBE = fnOf('fn_cash_cluster_lightning_thresholds_probe');
const READER = fnOf('fn_cash_cluster_lightning_thresholds');
const STATE = fnOf('fn_cash_cluster_lightning_state');

// ===========================================================================
//  1. THE SHAPE OF THE CHANGE
// ===========================================================================

describe('Phase 4 remediation: one transaction, three function bodies, no table touched', () => {
  it('is one transaction with a lock timeout, as the production DDL policy requires', () => {
    // Every DDL statement fires Supabase's schema-cache reload, which takes
    // about 28 seconds on this database, so three loose CREATEs plus their
    // grants and comments would mean nine reloads. Paired with a presence, so
    // that a file containing nothing at all could not satisfy it.
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE).toContain("SET LOCAL lock_timeout = '8s';");
    expect(count(CODE, /CREATE OR REPLACE FUNCTION/g)).toBe(3);
    expect(CODE).not.toMatch(/^ROLLBACK;$/m);
  });

  it('adds no column to any table, and would allow only one per ALTER TABLE if it did', () => {
    // There is no table DDL here at all - this migration re-cuts readers - so
    // the honest assertion is zero. The per-statement rule is still written
    // out rather than replaced by the zero, because the next Lightning
    // migration that DOES touch a table inherits this file's shape, and one
    // ADD COLUMN per ALTER TABLE is how this estate keeps a schema-cache
    // reload to one per statement.
    const alters = [...CODE.matchAll(/ALTER TABLE[\s\S]*?;/g)].map((m) => m[0]);
    expect(alters.length, 'this migration is not supposed to touch a table at all').toBe(0);
    for (const a of alters) {
      expect(count(a, /ADD COLUMN/g), `one ADD COLUMN per ALTER TABLE: ${flat(a)}`).toBe(1);
    }
    expect(CODE).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(CODE).not.toMatch(/\bDROP\s+/i);
    // And it writes no row either: cluster_mode is read and reported, never set.
    expect(CODE).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(CODE).not.toMatch(/\bUPDATE\s+public\./i);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).toMatch(/'cluster_mode',\s+g\.cluster_mode,/);
  });
});

// ===========================================================================
//  2. THE RULE IS A PURE FUNCTION, AND ITS GUARD AND ITS CAST ADMIT ONE SET
// ===========================================================================

describe('Phase 4 remediation: the threshold rule cannot raise on any configuration', () => {
  it('carries the integer pattern verbatim, and bounds the digits at nine', () => {
    // ^-?[0-9]{1,9}(\.0+)?$ IS THE WHOLE REPAIR, so it is pinned as an exact
    // string and then read for the two properties that make it correct rather
    // than merely present. At most nine digits means the largest value it can
    // admit is 999999999, which int4 holds; a tenth digit would let 2147483648
    // back through the guard and straight into the 22003 it used to raise. The
    // trailing-zero group is what makes 18.0 an acceptable spelling of 18.
    expect(PROBE.body).toContain("'^-?[0-9]{1,9}(\\.0+)?$'");
    const pattern = PROBE.body.match(/'(\^[^']*\$)'/)?.[1] ?? '';
    expect(pattern, 'the guard is no longer anchored at both ends').toMatch(/^\^.*\$$/);
    const bound = pattern.match(/\[0-9\]\{\d*,(\d+)\}/);
    expect(bound, 'the guard does not bound its digit count at all').toBeTruthy();
    expect(
      Number(bound?.[1]),
      'the guard admits more digits than int4 can hold'
    ).toBeLessThanOrEqual(9);
    expect(pattern, 'the guard refuses the trailing-zero decimal form').toContain('\\.0');
  });

  it('matches the TEXT with that pattern and then floors it through numeric, on both keys', () => {
    // THE PAIR, NOT EITHER HALF. A guard with no cast proves nothing and a cast
    // with no guard is the blocker. Both keys are asserted from both ends:
    // there is a `~` against the pattern, and the coercion that follows runs
    // floor(...::numeric)::integer, which accepts every string the guard admits.
    // A bare ::integer would refuse the '18.0' the guard has just let through -
    // which is precisely the gap 20260921064717 shipped.
    for (const key of ['on_threshold', 'off_threshold']) {
      expect(PROBE.body, `${key} is read without being matched against the pattern`).toMatch(
        new RegExp(`\\(\\s*p_cfg\\s*->>\\s*'${key}'\\s*\\)\\s*~\\s*v_int_re`)
      );
      expect(PROBE.body, `${key} is not floored through numeric`).toContain(
        `floor((p_cfg ->> '${key}')::numeric)::integer`
      );
      // The typeof guard is kept as well, because it is what keeps the string
      // "18" from being read as a number at all; it is simply no longer the
      // only thing standing between the config and the cast.
      expect(PROBE.body).toContain(`jsonb_typeof(p_cfg -> '${key}') = 'number'`);
    }
    // Said once more without naming a key, so a THIRD threshold added later
    // cannot arrive with the old shape.
    expect(PROBE.body, 'a configuration value is cast straight to an integer type').not.toMatch(
      /->>\s*'\w+'\s*\)\s*::\s*int/
    );
  });

  it('cannot raise at all: there is no RAISE anywhere in the probe body', () => {
    // The old assertion in the population suite looked for the string 'RAISE
    // EXCEPTION' and was green while the function raised 22P02 from a cast, so
    // this one is not the load-bearing pin - the guard/cast pair above is. It
    // is kept because the two together say something neither says alone: the
    // rule refuses a bad configuration by ANSWERING with the mandated defaults,
    // and there is no path out of it that is not a RETURN. The migration's own
    // post-apply read-back asserts the same thing against the live catalogue,
    // which is the half no source test can do.
    expect(PROBE.body).not.toMatch(/\bRAISE\b/);
    expect(PROBE.body).toContain("v_source := 'default_after_invalid_config';");
    expect(PROBE.body).toContain("'source', v_source,");
    // 'rejected' names the configured values that were thrown away, which is
    // the difference between {"on_threshold": 18.5} and {} - both answer 18
    // under source 'default', and without this key an operator who fat-fingers
    // a threshold gets no signal at all that it was discarded. A JSON null is
    // deliberately NOT rejected: clearing a value is a legitimate thing to
    // mean, and listing it would cry wolf on every intentional unset.
    expect(PROBE.body).toContain("'rejected', v_rejected);");
    expect(PROBE.body).toMatch(
      /ELSIF p_cfg \? 'on_threshold' AND jsonb_typeof\(p_cfg -> 'on_threshold'\) <> 'null' THEN/
    );
    expect(PROBE.body).toMatch(
      /ELSIF p_cfg \? 'off_threshold' AND jsonb_typeof\(p_cfg -> 'off_threshold'\) <> 'null' THEN/
    );
    expect(count(PROBE.body, /v_rejected := v_rejected \|\| to_jsonb\(/g)).toBe(2);
    expect(count(PROBE.body, /\bRETURN\b/g)).toBe(1);
    expect(SQL).toMatch(/RAISE EXCEPTION 'the live threshold rule can raise/);
  });

  it('is the only place the four mandated numbers are written', () => {
    // "No magic numbers in business logic" is a sentence in a specification
    // until something counts them. The whole point of the delegation is that
    // there is ONE copy: the Cluster-shaped reader became a row read and a
    // call, and it now knows no number at all. Counted over the function
    // BODIES with their string literals blanked, because the header argues its
    // case at length and names every number in it, and the post-apply read-back
    // has to name them too - it exists to check them against the catalogue.
    const carriers = FUNCTIONS.filter((f) => /\b(18|12|27)\b/.test(blankLiterals(f.body)));
    expect(carriers.map((f) => f.name)).toEqual(['fn_cash_cluster_lightning_thresholds_probe']);
    const probe = blankLiterals(PROBE.body);
    // 18 four times because it is both the six-max ON and the full-ring OFF,
    // and each pair is written once in the default branch and once in the
    // hysteresis fallback that answers when a configuration is refused.
    expect(count(probe, /\b18\b/g)).toBe(4);
    expect(count(probe, /\b12\b/g)).toBe(2);
    expect(count(probe, /\b27\b/g)).toBe(2);
    // And no FIFTH number: 6 is the band boundary, 2 the floor an OFF may not
    // go below, 0 the handedness that means "missing".
    expect([...new Set(probe.match(/\b\d+\b/g) ?? [])].sort()).toEqual(
      ['0', '12', '18', '2', '27', '6'].sort()
    );
    // The reader carries no integer at all, and asks the probe for both halves.
    expect(READER.body).toContain(
      "public.fn_cash_cluster_lightning_thresholds_probe(g.ruleset_snapshot -> 'lightning', g.handedness)"
    );
    expect(count(blankLiterals(READER.body), /\b\d+\b/g)).toBe(0);
    expect(READER.body).toContain("RETURN jsonb_build_object('ok', false, 'reason', 'not_found');");
  });
});

// ===========================================================================
//  3. THE VERDICT CAN SEE THE PENDING STATES
// ===========================================================================

const ON_ARM = span(STATE.body, "'would_turn_on',", "'would_turn_off',");
const OFF_ARM = span(STATE.body, "'would_turn_off',", "'live_eligible',");

describe('Phase 4 remediation: the verdict answers in the states that re-ask the question', () => {
  it('widens BOTH filters by exactly one state', () => {
    // The specification asks the same question twice on the way in and twice on
    // the way out, and the second asking happens in a PENDING state by
    // construction: ON step 5 sets PENDING_ON and step 11 recalculates and
    // aborts if the population has fallen; OFF step 2 accepts LIGHTNING or
    // PENDING_OFF and cancels the drain if the population recovers. A verdict
    // that only answers in must_move and lightning answers false at every one
    // of those second askings, so spec Phase 5 would abort every conversion it
    // ever started. Both arms are pinned, because widening one and forgetting
    // the other leaves the mirror defect in place.
    expect(ON_ARM).toBeTruthy();
    expect(OFF_ARM).toBeTruthy();
    expect(flat(ON_ARM)).toContain("g.cluster_mode IN ('must_move', 'pending_on')");
    expect(flat(OFF_ARM)).toContain("g.cluster_mode IN ('lightning', 'pending_off')");
  });

  it('leaves no single-state form alive anywhere outside a comment', () => {
    // NON-VACUITY, AND WHY THE STRIP IS NOT OPTIONAL. The header of this
    // migration quotes the very form the code must not carry - "would_turn_on
    // required cluster_mode = 'must_move'" - so this same assertion run against
    // the RAW file is false. Three proofs in this project have already gone
    // false for exactly that reason, which is why the strip is a rule here and
    // not a convenience. Asserted in both directions, so the strip is proven to
    // be doing work rather than assumed to be: if the header ever stops quoting
    // the old form, the first line goes red and this comment stops being true.
    expect(SQL, 'the header no longer quotes the old form, so the strip proves nothing').toMatch(
      /cluster_mode = 'must_move'/
    );
    expect(CODE).not.toMatch(/cluster_mode\s*=\s*'must_move'/);
    expect(CODE).not.toMatch(/cluster_mode\s*=\s*'lightning'/);
    expect(CODE).not.toMatch(/cluster_mode\s+IN\s*\(\s*'must_move'\s*\)/);
    expect(CODE).not.toMatch(/cluster_mode\s+IN\s*\(\s*'lightning'\s*\)/);
    // The only other comparison of cluster_mode in the file is the read-back's
    // "nothing converted" count, which is a <> and not a filter on the verdict.
    expect(CODE).toContain("WHERE cluster_mode <> 'must_move'");
  });

  it('gates would_turn_on on enabled and would_turn_off on nothing, deliberately', () => {
    // A disabled Cluster must not be allowed INTO Lightning and must always be
    // allowed to drain OUT of it. The asymmetry is the specification's, so both
    // halves are pinned: a presence on the ON side and an absence on the OFF
    // side, and the absence is checked with a word boundary so that
    // lightning_enabled - which the ON side legitimately reads - cannot satisfy
    // it by accident.
    // g.enabled bare, NOT coalesce(g.enabled, false): cash_games.enabled is
    // NOT NULL DEFAULT true, so the coalesce was cover over a case the column
    // cannot be in - the same dead-cover mistake this file's own header
    // criticises in the first cut's `v_on IS NULL` test. The assertion is
    // written in both directions so neither spelling can drift back in
    // unnoticed.
    expect(flat(ON_ARM)).toContain('AND g.enabled AND v_live >= v_on');
    expect(ON_ARM, 'the dead coalesce is back').not.toContain('coalesce(g.enabled');
    expect(OFF_ARM, 'would_turn_off has been gated on enabled').not.toMatch(/\benabled\b/);
    expect(flat(OFF_ARM)).toBe(
      "'would_turn_off', g.cluster_mode IN ('lightning', 'pending_off') AND v_live <= v_off, 'live_eligible',"
    );
    // ON is >= and OFF is <=, which is the specification's own asymmetry: it is
    // what makes 12 pending-off on a six-max game while 13 is not. Each arm is
    // checked for the ABSENCE of the strict form, because > instead of >= is a
    // one-character edit that moves every threshold in the estate by one player
    // and breaks nothing that compiles.
    expect(flat(ON_ARM)).toContain('v_live >= v_on');
    expect(ON_ARM).not.toMatch(/v_live >[^=]/);
    expect(flat(OFF_ARM)).toContain('v_live <= v_off');
    expect(OFF_ARM).not.toMatch(/v_live <[^=]/);
  });
});

// ===========================================================================
//  4. THE READER KEEPS ITS TEN KEYS AND COSTS ONE PLAN
// ===========================================================================

describe('Phase 4 remediation: the one reader the lobby embeds loses no field', () => {
  it('names exactly the ten top-level keys, asserted as a set', () => {
    // fn_cash_game_lobby EMBEDS this function, so a CREATE OR REPLACE that
    // silently dropped a key compiles, applies, passes every other check here
    // and breaks the lobby. This body has now been re-cut four times, which is
    // four chances to lose one. Asserted as a SET rather than a count, because
    // a count of ten is satisfied by nine right keys and one wrong one - and
    // the length is asserted beside it so that a duplicated key cannot pad the
    // set back up to full either.
    const RETURN_OBJECT = STATE.body.slice(STATE.body.indexOf('RETURN jsonb_build_object('));
    const keys = topKeys(RETURN_OBJECT);
    expect(new Set(keys)).toEqual(
      new Set([
        'game_id',
        'cluster_mode',
        'cluster_epoch',
        'lightning_enabled',
        'must_move',
        'enabled',
        'handedness',
        'open_cluster_sessions',
        'thresholds',
        'verdict',
      ])
    );
    expect(keys.length, 'a key is named twice at the top level').toBe(10);
    // And the open-session subselect is the same question, not merely the same
    // key name: a key that survived as a null would break the lobby just as
    // thoroughly as one that vanished.
    expect(flat(STATE.body)).toContain(
      'SELECT count(*)::integer INTO v_open FROM public.cash_player_session s ' +
        'WHERE s.cluster_id = g.id AND s.closed_at IS NULL;'
    );
    // The migration asserts the same ten against the live catalogue after it
    // applies, on every Cluster, which is the half no source test can do.
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'the re-created reader dropped a field on % cluster\(s\)'/
    );
  });

  it('is plpgsql, and calls each child exactly once into a local', () => {
    // THE COST, AND WHY THE LANGUAGE IS THE REPAIR. Both children carry SET
    // search_path, which disables SQL-function inlining, so the previous
    // sql-language shape planned three non-inlinable levels on every call:
    // measured warm on the busiest live Cluster, 3.746 ms against children
    // costing 0.126 ms and 0.025 ms, which is 3.6 ms of pure planning overhead
    // and 24% of a 15.6 ms lobby open, for an object nothing reads yet.
    // plpgsql caches its statement plans per session.
    expect(STATE.attrs).toMatch(/\bLANGUAGE plpgsql\b/);
    expect(STATE.attrs).not.toMatch(/\bLANGUAGE sql\b/);
    // The shape that cost the 3.6 ms is gone, and each child is called once
    // into a local rather than once per reference - the verdict refers to the
    // number four times.
    expect(STATE.body).not.toContain('CROSS JOIN LATERAL');
    expect(count(STATE.body, /public\.fn_cash_cluster_live_eligible\(/g)).toBe(1);
    expect(count(STATE.body, /public\.fn_cash_cluster_lightning_thresholds\(/g)).toBe(1);
    expect(STATE.body).toContain('v_live := public.fn_cash_cluster_live_eligible(g.id);');
    expect(STATE.body).toContain('v_th   := public.fn_cash_cluster_lightning_thresholds(g.id);');
    // A lobby open must not pay for nine statements of explanation nobody asked
    // for: the reader asks the scalar, never the breakdown.
    expect(STATE.body).not.toContain('fn_cash_cluster_population');
  });

  it('reports the measurement as a NOTICE and never asserts a timing threshold', () => {
    // A cost claim with no number in it is how the previous cut shipped 3.6 ms
    // of planning overhead, and a timing THRESHOLD in a migration is a flake
    // waiting for a busy afternoon. So the file measures, names the number it
    // is being compared against, and raises nothing.
    const TIMING = span(CODE, 'DO $timing$', 'END $timing$;');
    expect(TIMING).toBeTruthy();
    expect(TIMING).toContain('RAISE NOTICE');
    expect(TIMING, 'a timing threshold in a migration is a flake').not.toContain('RAISE EXCEPTION');
    expect(TIMING).toContain('clock_timestamp()');
    expect(SQL).toContain('3.746');
    expect(SQL).toContain('0.151');
  });
});

// ===========================================================================
//  5. THREE FUNCTIONS, THREE SETS OF ATTRIBUTES, THREE PAIRS OF GRANTS
// ===========================================================================

/**
 * The volatility each function must declare. Written as a map keyed by name and
 * then asserted to COVER the discovered set, so a fourth function cannot be
 * added without an entry being argued for here first.
 */
const VOLATILITY: Record<string, string> = {
  fn_cash_cluster_lightning_thresholds_probe: 'IMMUTABLE',
  fn_cash_cluster_lightning_thresholds: 'STABLE',
  fn_cash_cluster_lightning_state: 'STABLE',
};

describe('Phase 4 remediation: every function it writes is an invoker, pinned and service_role only', () => {
  it('declares the right volatility, and the map covers every function in the file', () => {
    // IMMUTABLE for the probe because it is a pure function of its arguments -
    // that is what makes it fuzzable from a @live-proof against production with
    // no Cluster to hang it on - and STABLE for the two readers because they
    // read rows. Getting this wrong is not cosmetic: an IMMUTABLE function that
    // reads a table can be folded at plan time and answer from a snapshot
    // nobody chose.
    expect(FUNCTIONS.length, 'the function parser found nothing to check').toBe(3);
    expect(Object.keys(VOLATILITY).sort()).toEqual(FUNCTIONS.map((f) => f.name).sort());
    for (const f of FUNCTIONS) {
      expect(f.attrs, `${f.name} has the wrong volatility`).toContain(VOLATILITY[f.name]);
    }
    expect(PROBE.attrs).not.toContain('STABLE');
    expect(READER.attrs).not.toContain('IMMUTABLE');
    expect(STATE.attrs).not.toContain('IMMUTABLE');
    expect(FUNCTIONS.every((f) => !/\bVOLATILE\b/.test(f.attrs))).toBe(true);
  });

  it('is SECURITY INVOKER with a pinned search_path, in all three', () => {
    // SECURITY INVOKER deliberately, and the REVOKE below is why it matters:
    // RLS is on for cash_games, so an INVOKER function run by anon would read
    // FEWER rows rather than raise, and a threshold input that is quietly wrong
    // is worse than one that refuses. 20260920234647 exists in part to flip
    // fn_cash_cluster_lightning_state OFF definer and carries a @live-proof for
    // `NOT p.prosecdef`; a re-create that said DEFINER again - or that left the
    // clause off and relied on the default - would quietly undo that migration.
    for (const f of FUNCTIONS) {
      expect(f.attrs, `${f.name} is not SECURITY INVOKER`).toContain('SECURITY INVOKER');
      expect(f.attrs, `${f.name} is a definer`).not.toContain('SECURITY DEFINER');
      expect(f.attrs, `${f.name} does not pin its search_path`).toContain(
        "SET search_path TO 'public', 'pg_temp'"
      );
    }
  });

  it('revokes and grants EVERY function it writes, counted from both ends', () => {
    // DRIVEN OFF THE DISCOVERED SET, NOT A LIST. A fourth function added to
    // this migration later would arrive with no REVOKE and no GRANT and
    // therefore with PUBLIC EXECUTE, which is the default, which is how an
    // internal reader ends up reachable from a browser. Counting from both
    // ends is what closes it: every function has a pair, and there are exactly
    // as many pairs as there are functions, so neither a missing grant nor a
    // stray one naming something this file does not write can pass.
    for (const f of FUNCTIONS) {
      const sig = `public.${f.name}(${f.argTypes})`;
      expect(CODE, `${f.name} is not revoked from the browser roles`).toContain(
        `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(CODE, `${f.name} is not granted to service_role`).toContain(
        `GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`
      );
      expect(SQL, `${f.name} has no COMMENT`).toMatch(
        new RegExp(`COMMENT ON FUNCTION public\\.${f.name}\\([^)]*\\) IS\\s+'`)
      );
    }
    expect(count(CODE, /^REVOKE ALL ON FUNCTION /gm)).toBe(FUNCTIONS.length);
    expect(count(CODE, /^GRANT EXECUTE ON FUNCTION /gm)).toBe(FUNCTIONS.length);
    expect(count(SQL, /^COMMENT ON FUNCTION /gm)).toBe(FUNCTIONS.length);
    // AND NOTHING IS GRANTED TO THE BROWSER. Asserted over BIZ rather than
    // CODE, and the reason is the defect class this whole file is about: the
    // probe's own COMMENT says it was "granted to authenticated", which is a
    // sentence describing the blocker, and a rule that read CODE would match
    // that sentence and go red on correct code. Stated in both directions so
    // the blanking is proven to be doing work.
    expect(CODE, 'the COMMENT no longer describes the definer path').toMatch(
      /GRANT[^;]*\bTO\b[^;]*\bauthenticated\b/i
    );
    expect(BIZ, 'something in this file grants a browser role').not.toMatch(
      /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
  });
});

// ===========================================================================
//  6. THE PROOFS, AND THE CI CLAIM THE HEADER MAKES
// ===========================================================================

describe('Phase 4 remediation: it proves what it says, and says nothing CI does not do', () => {
  it('declares live proofs, every one of them a balanced parenthesised SELECT', () => {
    // The harness wraps each in a SELECT and expects a single true-ish scalar,
    // so a proof that is two statements, or one that does not close its own
    // parenthesis, is not a proof at all - it is a syntax error at verify time.
    // Balanced with the string literals blanked first, because several of these
    // proofs quote regexes containing \( and \), and reading a quoted paren as
    // structure would fail a proof that is perfectly well formed.
    //
    // A FLOOR, NEVER AN EQUALITY, for the same reason the sibling file says so:
    // a count written down in prose is exactly the thing that goes stale. What
    // IS asserted exactly is that the extraction and the raw lines agree, so a
    // proof cannot be silently dropped by the regex that harvests them. (The
    // brief for this file said nineteen; there are eighteen @live-proof lines
    // and one prose mention of the token in the header, which is precisely the
    // failure mode the floor exists for.)
    expect(PROOFS.length, 'the extraction lost a proof line').toBe(PROOF_LINES.length);
    expect(PROOFS.length, 'the file has stopped proving things').toBeGreaterThanOrEqual(18);
    for (const p of PROOFS) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
      expect(balanced(p), `unbalanced parentheses in a proof: ${p}`).toBe(true);
    }
  });

  it('strips comments from every function body a proof text-matches against', () => {
    // THE REGRESSION TEST FOR A DEFECT CLASS, NOT FOR AN INCIDENT. Three proofs
    // in 20260921064717 went false because the body they read with
    // pg_get_functiondef quoted, IN A COMMENT, the exact string the proof
    // forbade. The comment was the right thing to have written and the proof
    // was the wrong way to ask. So any proof that calls pg_get_functiondef AND
    // applies a text operator to the result must also call regexp_replace.
    const TEXT_OPERATORS = ['position(', ' ~ ', ' !~ ', 'regexp_matches'];
    let wrapped = 0;
    for (const p of PROOFS) {
      if (!p.includes('pg_get_functiondef')) continue;
      if (!TEXT_OPERATORS.some((op) => p.includes(op))) continue;
      expect(p, `this proof reads a body as text without stripping its comments: ${p}`).toContain(
        'regexp_replace'
      );
      wrapped++;
    }
    expect(
      wrapped,
      'no proof reads a body as text, so this rule is vacuous'
    ).toBeGreaterThanOrEqual(5);
    // And the strip they all apply is the same one this file applies, spelled
    // the way a migration has to spell it.
    expect(PROOFS.join('\n')).toContain("'--[^' || chr(10) || ']*', '', 'g'");
    // The proofs cover the three things a source test cannot: the pattern is in
    // the LIVE body, the live body cannot raise, and both widened filters are
    // in the LIVE verdict.
    const all = PROOFS.join('\n');
    expect(all).toContain('fn_cash_cluster_lightning_thresholds_probe');
    expect(all).toContain("position('RAISE' in regexp_replace(");
    expect(all).toContain("cluster_mode IN \\(''must_move'', ''pending_on''\\)");
    expect(all).toContain("cluster_mode IN \\(''lightning'', ''pending_off''\\)");
    expect(all).toContain("lanname = 'plpgsql'");
    expect(all).toContain('role_routine_grants');
  });

  it('makes a claim about CI gating that the workflow itself still honours', () => {
    // THE HEADER ARGUES THAT AN AUDIT WAS WRONG, AND THIS IS WHAT KEEPS THAT
    // ARGUMENT HONEST. The audit reported that the Lightning harnesses sit in a
    // job that gates nothing, because "Accounting transactions (PostgreSQL 17)"
    // is not itself a required check. It is not - and it does gate one: the
    // `server` job needs accounting_postgres, runs `if: always()`, is named
    // "Server Engine (typecheck + tests)" which IS required, and exits 1 unless
    // ACCOUNTING_RESULT is success or a skip it can explain.
    //
    // So the header's own quotation of the needs list is compared against the
    // workflow, rather than either being trusted alone. The LINE NUMBER the
    // header also carries is deliberately NOT pinned: adding one step to
    // accounting_postgres moves every line below it, and wiring this
    // migration's own harness into that job moved the `server` job down by
    // four. A test that pinned the integer would go red for a change that made
    // the claim more true, which is how a proof becomes something people learn
    // to edit rather than believe.
    const SERVER = jobBlock('server');
    expect(SERVER, 'there is no server job in the workflow at all').toBeTruthy();
    const needs = (SERVER.match(/^ {4}needs:\s*\[([^\]]*)\]/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    expect(needs, 'the required check no longer needs the accounting job').toContain(
      'accounting_postgres'
    );
    expect(SERVER).toContain('name: Server Engine (typecheck + tests)');
    expect(SERVER).toMatch(/^ {4}if: always\(\)$/m);
    expect(SERVER).toContain('ACCOUNTING_RESULT: ${{ needs.accounting_postgres.result }}');
    expect(SERVER, 'the gate no longer fails on a bad accounting result').toContain('exit 1');
    // The header quotes the needs list verbatim; the quotation is compared with
    // what the workflow actually says, so the header cannot rot.
    const claimed = SQL.match(/`needs: \[([^\]]*)\]`/)?.[1];
    expect(claimed, 'the header no longer quotes the needs list it is arguing from').toBeTruthy();
    expect((claimed ?? '').split(',').map((s) => s.trim())).toEqual(needs);
    expect(SQL).toContain('.github/workflows/ci.yml');
    expect(SQL).toContain('Server Engine (typecheck + tests)');
  });

  it('is wired into the accounting job, immediately after its Phase 4 sibling', () => {
    // A WIRED STEP THAT POINTS AT NOTHING IS A RED CI RUN AND NOTHING ELSE, so
    // the path is checked against the disk as well as against the workflow.
    // The step runs AFTER the population harness rather than before it, because
    // the remediation is applied on top of 20260921064717 and its own fixture
    // chain reproduces the blocker against that body first.
    expect(
      fs.existsSync(path.join(ROOT, 'scripts/dev/test-lightning-phase4-remediation.sh')),
      'ci.yml runs a harness that is not in the tree'
    ).toBe(true);
    const ACCOUNTING = jobBlock('accounting_postgres');
    expect(ACCOUNTING, 'there is no accounting_postgres job in the workflow').toBeTruthy();
    const harnesses = [
      ...ACCOUNTING.matchAll(/run: bash (scripts\/dev\/test-lightning-[\w-]+\.sh)/g),
    ].map((m) => m[1]);
    expect(harnesses).toContain('scripts/dev/test-lightning-phase4-population.sh');
    expect(harnesses).toContain('scripts/dev/test-lightning-phase4-remediation.sh');
    expect(harnesses.indexOf('scripts/dev/test-lightning-phase4-remediation.sh')).toBe(
      harnesses.indexOf('scripts/dev/test-lightning-phase4-population.sh') + 1
    );
    // Every Lightning harness runs with the same PG_BIN the rest of the job
    // uses, so the new step cannot silently pick up a different PostgreSQL.
    expect(ACCOUNTING).toContain(
      '      - name: Lightning Phase 4 remediation repairs the threshold reader, the verdict and the plan\n' +
        '        env:\n' +
        '          PG_BIN: /usr/lib/postgresql/17/bin\n' +
        '        run: bash scripts/dev/test-lightning-phase4-remediation.sh'
    );
  });
});
