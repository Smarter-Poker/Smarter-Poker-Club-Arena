/**
 * LIGHTNING 2.0 PHASE 4: ONE LIVE ELIGIBLE POPULATION, AND THE THRESHOLDS IT
 * IS JUDGED BY.
 *
 * 20260921064717 adds a SECOND number to an estate that already fought a war
 * over its first one. tests/one-definition-of-a-games-players.law.test.ts pins
 * the BOARD count - "how many players are in this game" - across
 * fn_cash_cluster_census, get_club_home and fn_cash_game_lobby, and it
 * deliberately counts a sitting-out player, a busted player inside their rebuy
 * window and a player on their way out, because all three are in the game and
 * the lobby must say so. The LIVE ELIGIBLE POPULATION answers a different
 * question - "how many players could Lightning deal to right now" - and it is
 * the input to a threshold, so it counts only players who can be dealt in.
 *
 * Two numbers that look alike are exactly how the first war started, and the
 * next reconciliation pass will helpfully merge them unless the difference is
 * written down somewhere that fails. No source test can say the population is
 * CORRECT; what it can say is that the five things which would let the two
 * drift together, or let the threshold be quietly wrong, are still true:
 *
 *   1. THERE IS ONE PREDICATE, AND THE BREAKDOWN DOES NOT RECOMPUTE IT.
 *      fn_cash_cluster_live_eligible is the number; fn_cash_cluster_population
 *      is nine statements of explanation wrapped around a call to it; and
 *      fn_cash_cluster_lightning_state - which fn_cash_game_lobby embeds on
 *      every open - reads the scalar rather than the breakdown.
 *
 *   2. THE TABLE PREDICATE IS THE CENSUS'S. Every reader here narrows the SEAT
 *      predicate and nothing else. The census's own WHERE clause is read out of
 *      its own migration below and compared against all six copies of it in
 *      this file, so the day somebody re-cuts either, this says so - rather
 *      than the board and the threshold counting two different games.
 *
 *   3. THE FOUR MANDATED NUMBERS LIVE IN ONE FUNCTION. "No magic numbers in
 *      business logic" is a sentence in a specification until something counts
 *      them, so this counts them.
 *
 *   4. A HORSE COUNTS EXACTLY LIKE A HUMAN (Law 10.5). The eligibility filter
 *      is asserted as one exact string, because an exact string is the only
 *      assertion that refuses a fifth clause nobody argued for.
 *
 *   5. THE READER KEPT EVERYTHING IT ALREADY CARRIED. fn_cash_game_lobby
 *      embeds fn_cash_cluster_lightning_state, so a CREATE OR REPLACE that
 *      silently dropped a key would break the lobby and compile perfectly.
 *      The reader has now been re-cut FOUR times - 20260921142954 re-cut it
 *      again, to widen the verdict and to drop a level of planning - and this
 *      matters more each time.
 *
 * And one rule about the PROOFS rather than the code. Three of this file's
 * @live-proof lines went false purely because the function body they read
 * quoted, IN A COMMENT, the very string they forbade. A proof that reads a
 * body with pg_get_functiondef and matches text against it must strip comments
 * first, or it is asserting something about the prose. That is a defect class,
 * not an incident, so it is pinned as a rule over every proof in the file.
 *
 * LIGHTNING_P4_MIGRATION overrides the file under test, so mutation testing -
 * copying the migration to a scratch directory, breaking one line of the copy
 * and watching this suite go red - never has to touch the migration in the
 * repository. It is the same mechanism its siblings take as
 * LIGHTNING_P3_MIGRATION and LIGHTNING_P3R_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql';
const MIGRATION = process.env.LIGHTNING_P4_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');

/**
 * Comment-stripped, so no pin below can be satisfied by prose. The header of
 * this migration argues its case at length and names every number in it; a
 * test that read SQL rather than CODE would be pinning the argument instead of
 * the code that has to honour it. It is the same strip the file's own proofs
 * now apply to the bodies they read, and for the same reason.
 */
const CODE = SQL.replace(/--[^\n]*/g, '');

/**
 * Comment-stripped AND string-literal-blanked, keeping every offset, so a span
 * taken from CODE can be found at the same place here. The COMMENT ON FUNCTION
 * bodies and the RAISE EXCEPTION messages are prose that happens to sit inside
 * quotes - "6-max 18/12, full ring 27/18" is a sentence, not a threshold - and
 * counting them as code would make the magic-number count below mean nothing.
 */
const blankLiterals = (s: string): string =>
  s.replace(/'(?:''|[^'])*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`);

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

/** The five functions the migration writes out in full. */
const THRESHOLDS = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)',
  '$fn$;'
);
const SCALAR = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible(',
  '$fn$;'
);
const POPULATION = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_population(',
  '$fn$;'
);
const STATE = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)',
  '$function$;'
);

/** The post-apply read-back. Asserted against SQL: its RAISE messages are the rule. */
const READ_BACK = span(SQL, 'DO $assert$', 'END $assert$;');

/** Every @live-proof expression, in file order. */
const PROOFS = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);

/**
 * The proofs that state the breakdown/predicate identity. Selected by a term
 * only they name, so the selection does not depend on how they are spelled.
 */
const IDENTITY_PROOFS = PROOFS.filter((proof) => proof.includes("->> 'seated_and_pooled'"));

/**
 * THE BUSINESS LOGIC: everything the database will execute on a tick, which is
 * the whole file minus its prose, minus the text inside its quotes and minus
 * the post-apply read-back. The read-back is excluded deliberately - it exists
 * to check the mandated numbers against the live catalogue, so it has to name
 * them, and a rule that forbade it from naming them would forbid the check.
 */
const BIZ = (() => {
  const blanked = blankLiterals(CODE);
  const at = blanked.indexOf('DO $assert$');
  return at < 0 ? blanked : blanked.slice(0, at);
})();
const THRESHOLDS_BIZ = span(
  BIZ,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)',
  '$fn$;'
);
/** The business logic with the one function allowed to know a number cut out of it. */
const OUTSIDE_THRESHOLDS = (() => {
  const at = BIZ.indexOf(THRESHOLDS_BIZ);
  return at < 0 ? BIZ : BIZ.slice(0, at) + BIZ.slice(at + THRESHOLDS_BIZ.length);
})();

/**
 * The census's own table predicate, read out of whichever migration most
 * recently re-cuts fn_cash_cluster_census, so this tracks the census rather
 * than a copy of it. BOTH sides are normalised the SAME way and only in two
 * respects, each named here because a normalisation is a hole:
 *   - runs of whitespace collapse to one space, because the census indents its
 *     WHERE one level deeper than most of the copies in this file;
 *   - the cluster id EXPRESSION becomes a placeholder, because the census names
 *     its own parameter (p_game_id) and the readers here name the row they have
 *     already selected (g.id). Everything downstream of that - the three
 *     exclusions, which are the whole rule - is compared byte for byte.
 */
const normalise = (s: string): string =>
  flat(s).replace(/tb\.cluster_id = [A-Za-z_][\w.]*/g, 'tb.cluster_id = <the cluster>');
const CENSUS_PREDICATE = (() => {
  const file = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      fs
        .readFileSync(path.join(MIGRATIONS, f), 'utf8')
        .includes('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_census(')
    )
    .pop();
  if (!file) return '';
  const body = span(
    fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'),
    'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_census(',
    '$$;'
  );
  const raw = body.match(/WHERE tb\.cluster_id = \S+[\s\S]*?tb\.lifecycle <> 'closed'/)?.[0];
  return raw ? normalise(raw) : '';
})();
const copiesIn = (s: string): number =>
  CENSUS_PREDICATE === '' ? -1 : normalise(s).split(CENSUS_PREDICATE).length - 1;

/**
 * THE THRESHOLD RULE AS IT STANDS, rather than the copy this file was written
 * against. 20260921142954 re-cut fn_cash_cluster_lightning_thresholds, so the
 * body the database executes is no longer the one in FILE, and a guard/cast pin
 * that read FILE alone would be pinning a body nothing runs. So it reads
 * whichever migration most recently writes the function out - the same
 * mechanism CENSUS_PREDICATE uses to track the census rather than a copy of it.
 * When the file under test IS the newest definer, the LIGHTNING_P4_MIGRATION
 * override is honoured, so mutation testing still bites here.
 */
const LIVE_RULE = (() => {
  const definer = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      fs
        .readFileSync(path.join(MIGRATIONS, f), 'utf8')
        .includes('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(')
    )
    .pop();
  if (!definer) return '';
  const text = definer === FILE ? SQL : fs.readFileSync(path.join(MIGRATIONS, definer), 'utf8');
  return text.replace(/--[^\n]*/g, '');
})();

/** The identifier that holds the Lightning configuration object in a rule body. */
const configIdent = (rule: string): string =>
  rule.match(/([A-Za-z_]\w*)\s*:=\s*[\w.]+\s*->\s*'lightning'/)?.[1] ??
  rule.match(/jsonb_typeof\(\s*([A-Za-z_]\w*)\s*\)\s*=\s*'object'/)?.[1] ??
  '';

/** A quoted pattern, or the pattern the named constant is initialised with. */
const patternOf = (rule: string, operand: string): string =>
  operand.startsWith("'")
    ? operand
    : (rule.match(
        new RegExp(`${operand}\\s+(?:constant\\s+)?\\w+\\s*:=\\s*('(?:''|[^'])*')`)
      )?.[1] ?? '');

/**
 * Every read of a configuration key out of the rule, with whatever operator is
 * applied to it: a `~` match against a pattern, or a `::` coercion. That pair is
 * where the Phase 4 blocker lived - a guard and a cast admitting different sets.
 */
const configReads = (
  rule: string,
  cfg: string
): { key: string; op: string; before: string; pattern: string }[] =>
  [
    ...rule.matchAll(
      new RegExp(
        `\\(\\s*${cfg}\\s*->>\\s*'(\\w+)'\\s*\\)\\s*(::\\s*\\w+|~\\s*(?:'(?:''|[^'])*'|\\w+))?`,
        'g'
      )
    ),
  ].map((m) => {
    const op = flat(m[2] ?? '');
    const at = m.index ?? 0;
    return {
      key: m[1],
      op,
      before: rule.slice(Math.max(0, at - 10), at),
      pattern: op.startsWith('~') ? patternOf(rule, op.replace(/^~\s*/, '')) : '',
    };
  });

// ===========================================================================
//  1. THE THRESHOLDS, IN ONE PLACE
// ===========================================================================

describe('Phase 4: the thresholds are configuration, and the defaults live in one function', () => {
  it('is a stable invoker with a pinned search_path, out of the browser and granted to one role', () => {
    // SECURITY INVOKER deliberately, and the REVOKE is why it matters: RLS is
    // on for cash_games, so an INVOKER function run by anon would read FEWER
    // rows rather than raise - a threshold input that is quietly wrong is
    // worse than one that refuses. The search_path is pinned so a caller
    // cannot shadow public.cash_games with one of their own. The COMMENT is
    // the only place a reader of the catalogue alone learns any of this.
    expect(THRESHOLDS).toBeTruthy();
    expect(THRESHOLDS).toContain('STABLE');
    expect(THRESHOLDS).toContain('SECURITY INVOKER');
    expect(THRESHOLDS).not.toContain('SECURITY DEFINER');
    expect(THRESHOLDS).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) TO service_role;'
    );
    expect(
      count(CODE, /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_lightning_thresholds/g)
    ).toBe(1);
    expect(SQL).toMatch(
      /COMMENT ON FUNCTION public\.fn_cash_cluster_lightning_thresholds\(uuid\) IS\s+'/
    );
  });

  it('writes the four mandated numbers exactly twice each, and nowhere but in this function', () => {
    // "NO MAGIC NUMBERS IN BUSINESS LOGIC", MADE CHECKABLE. The specification
    // mandates four numbers - 6-max ON 18 / OFF 12, full ring ON 27 / OFF 18 -
    // and each of them is written exactly twice: once in the default branch
    // and once in the hysteresis fallback that answers when a configuration is
    // refused. So the four mandated numbers are eight tokens, which as raw
    // counts is 18 four times (it is both the six-max ON and the full-ring
    // OFF), 12 twice and 27 twice.
    //
    // Counted over the business logic: comments stripped, string literals
    // blanked, post-apply read-back removed. A second copy of any of them
    // anywhere else - a caller that "knows" 18, a default duplicated into
    // fn_cash_cluster_pool_health or into the scalar - fails here, which is
    // the whole point of there being one place.
    expect(count(BIZ, /\b18\b/g)).toBe(4);
    expect(count(BIZ, /\b12\b/g)).toBe(2);
    expect(count(BIZ, /\b27\b/g)).toBe(2);
    expect(THRESHOLDS_BIZ).toBeTruthy();
    expect(count(OUTSIDE_THRESHOLDS, /\b(18|12|27)\b/g)).toBe(0);
    // And the callers ASK rather than carry: the reader and the pool health
    // both go through the one function for their numbers.
    expect(OUTSIDE_THRESHOLDS).toContain('public.fn_cash_cluster_lightning_thresholds(g.id)');
    expect(OUTSIDE_THRESHOLDS).toContain('public.fn_cash_cluster_lightning_thresholds(p_game_id)');
  });

  it('carries no other threshold constant, in this function or anywhere else', () => {
    // The count above refuses a FIFTH copy of a mandated number. This refuses
    // a fifth NUMBER: a new band, a new floor, a retuned default. Inside the
    // thresholds function the only integers allowed beside the mandated four
    // are 9 (the handedness a null row is read as), 6 (the band boundary) and
    // 2 (the floor below which an OFF threshold is nonsense).
    expect([...new Set(blankLiterals(THRESHOLDS).match(/\b\d+\b/g) ?? [])].sort()).toEqual(
      ['12', '18', '2', '27', '6', '9'].sort()
    );
    // And across the whole of the business logic there is no other multi-digit
    // constant at all. 100 is the `100.0 *` of the seat-occupancy percentage
    // in fn_cash_cluster_pool_health, which is a unit and not a threshold.
    expect([...new Set(BIZ.match(/\b\d{2,}\b/g) ?? [])].sort()).toEqual(
      ['100', '12', '18', '27'].sort()
    );
  });

  it('puts the band boundary at <= 6, and has no second boundary to drift from it', () => {
    // handedness is the seats at ONE table, so six and below is the 6-max
    // band. Every comparison of handedness in the function is that same
    // boundary spelled the same way - the default branch, the hysteresis
    // fallback and the `band` label the answer carries - so the label can
    // never say six_max while the numbers say full ring.
    expect(
      [...THRESHOLDS.matchAll(/handedness[^\n]*?([<>]=?)\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`)
    ).toEqual(['<= 6', '<= 6', '<= 6']);
    expect(THRESHOLDS).toContain(
      "'band', CASE WHEN coalesce(g.handedness, 9) <= 6 THEN 'six_max' ELSE 'full_ring' END,"
    );
  });

  it('answers 18/12 below the boundary and 27/18 above it, in one exact line', () => {
    // Asserted as one exact string rather than four contains(): a pair of
    // contains() passes just as happily on a branch that gives a six-max game
    // the full-ring numbers.
    const DEFAULTS = span(THRESHOLDS, 'IF coalesce(g.handedness, 9) <= 6 THEN', 'END IF;');
    expect(flat(DEFAULTS)).toBe(
      'IF coalesce(g.handedness, 9) <= 6 THEN v_on := 18; v_off := 12; ELSE v_on := 27; v_off := 18; END IF;'
    );
  });

  it('prefers a stated configuration, and says which of the two answered', () => {
    // The numbers are DEFAULTS, not the rule: cash_games.ruleset_snapshot ->
    // 'lightning' is the jsonb every other cash rule already lives in. The
    // typeof guard is what keeps a string "18" or a null from becoming a
    // threshold. `source` is how a reader tells a deliberate setting from a
    // default it merely inherited.
    expect(THRESHOLDS).toContain("v_cfg := g.ruleset_snapshot -> 'lightning';");
    expect(THRESHOLDS).toContain("IF jsonb_typeof(v_cfg -> 'on_threshold') = 'number' THEN");
    expect(THRESHOLDS).toContain("IF jsonb_typeof(v_cfg -> 'off_threshold') = 'number' THEN");
    expect(THRESHOLDS).toMatch(/v_source := 'ruleset';/);
    expect(THRESHOLDS).toContain("'source', v_source);");
  });

  it('REFUSES an inverted configuration rather than raising on it', () => {
    // "The OFF threshold provides hysteresis and prevents rapid ON/OFF
    // oscillation." An OFF at or above the ON converts a Cluster every tick,
    // forever, in both directions - so the rule is enforced here rather than
    // trusted. But it is enforced by REFUSING: this function is read on the
    // path a tick takes and on the path a lobby open takes, and a reader that
    // raises takes both down with it for every Cluster on the board, not just
    // the misconfigured one. So the invalid branch assigns the mandated
    // defaults, stamps `source` so the answer admits what happened, and
    // returns.
    const HYSTERESIS = span(
      THRESHOLDS,
      'IF v_on IS NULL OR v_off IS NULL',
      "v_source := 'default_after_invalid_config';"
    );
    expect(HYSTERESIS).toBeTruthy();
    expect(flat(HYSTERESIS)).toBe(
      'IF v_on IS NULL OR v_off IS NULL OR v_on <= v_off OR v_off < 2 THEN ' +
        'IF coalesce(g.handedness, 9) <= 6 THEN v_on := 18; v_off := 12; ' +
        "ELSE v_on := 27; v_off := 18; END IF; v_source := 'default_after_invalid_config';"
    );
    // WHY THE ASSERTION THAT USED TO SIT HERE WAS WORSE THAN USELESS, AND WHAT
    // REPLACED IT.
    //
    // It read `expect(THRESHOLDS).not.toContain('RAISE EXCEPTION')`, and it was
    // green on every run of this suite while the live function raised 22P02 on
    // a configuration an operator could legitimately write. It looked for a
    // RAISE STATEMENT. The raise did not come from a statement. It came from a
    // CAST: the body guarded the configuration with `jsonb_typeof(...) =
    // 'number'` and then coerced it with `::integer`, and those two admit
    // DIFFERENT SETS. The guard admits every JSON number; the cast accepts only
    // int4; everything in the gap - 18.0, 18.5, 1e300, 2147483648 - raised
    // 22P02 or 22003 from inside an expression, with no RAISE anywhere near it.
    // 18.0 is the one that matters: jsonb preserves the trailing zero and
    // to_jsonb(numeric) produces it. The error propagated up through
    // fn_cash_cluster_lightning_state into fn_cash_game_lobby, which is
    // SECURITY DEFINER, granted to authenticated and polled every five seconds
    // while the modal is open. 20260921142954 is the repair.
    //
    // So the old line asserted the absence of the one spelling of "this can
    // fail" that nobody had written, two lines below the spelling that was
    // actually there. An absence assertion that cannot name the mechanism it
    // refuses is a comment with an expect() around it, and this one stood in
    // front of the defect for the whole of its life without seeing it.
    //
    // WHAT REPLACES IT CATCHES THE CLASS: A GUARD AND A CAST THAT ADMIT
    // DIFFERENT SETS. It parses both out of whichever migration currently
    // defines the rule and pins the PAIR rather than either half -
    //
    //   - every configuration key that is turned into a number must first be
    //     matched against an ANCHORED pattern that BOUNDS THE DIGIT COUNT, so
    //     the guard cannot admit a value int4 has no room for;
    //   - that bound is at most nine digits, which is what makes it true;
    //   - the pattern must admit the trailing-zero decimal form, because that
    //     is the shape a serialiser produces and refusing an operator's
    //     obviously correct intent is its own defect; and
    //   - the coercion must therefore run through numeric and floor(), never a
    //     bare ::integer, because ::integer refuses the '18.0' the guard has
    //     just admitted.
    //
    // Pointed at 20260921064717's own body this fails on the first clause:
    // neither key carries a `~` guard at all and both go straight to
    // ::integer. That is the blocker, written down as an assertion.
    expect(LIVE_RULE, 'no migration writes out the threshold rule').toBeTruthy();
    const cfgIdent = configIdent(LIVE_RULE);
    expect(cfgIdent, 'the rule no longer reads a configuration object at all').toBeTruthy();
    const reads = configReads(LIVE_RULE, cfgIdent);
    expect([...new Set(reads.map((r) => r.key))].sort()).toEqual(['off_threshold', 'on_threshold']);
    for (const key of ['on_threshold', 'off_threshold']) {
      const mine = reads.filter((r) => r.key === key);
      const guards = mine.filter((r) => r.op.startsWith('~'));
      const casts = mine.filter((r) => r.op.startsWith('::'));
      expect(guards.length, `${key} is read with no textual guard at all`).toBeGreaterThan(0);
      expect(casts.length, `${key} is never coerced, so this pin would be vacuous`).toBeGreaterThan(
        0
      );
      for (const g of guards) {
        expect(g.pattern, `${key}'s guard is not a pattern this test can read`).toBeTruthy();
        expect(g.pattern, `${key}'s guard is not anchored at both ends`).toMatch(/^'\^.*\$'$/);
        const bound = g.pattern.match(/\[0-9\]\{\d*,(\d+)\}/);
        expect(bound, `${key}'s guard does not bound its digit count`).toBeTruthy();
        expect(
          Number(bound?.[1]),
          `${key}'s guard admits more digits than int4 can hold`
        ).toBeLessThanOrEqual(9);
        expect(g.pattern, `${key}'s guard refuses the trailing-zero decimal form`).toContain(
          '\\.0'
        );
      }
      for (const c of casts) {
        expect(c.op, `${key} is cast straight to integer, which is the blocker`).toBe('::numeric');
        expect(c.before, `${key} is coerced without flooring`).toContain('floor(');
      }
    }
    // Said once more without reference to how the guard is spelled, so a rule
    // rewritten in a shape this parser cannot read still cannot reintroduce the
    // bare cast by being unreadable.
    expect(LIVE_RULE, 'a configuration value is cast straight to an integer type').not.toMatch(
      new RegExp(`\\(\\s*${cfgIdent}\\s*->>\\s*'\\w+'\\s*\\)\\s*::\\s*int`)
    );
    // A missing game is the same kind of refusal, for the same reason.
    expect(THRESHOLDS).toContain("RETURN jsonb_build_object('ok', false, 'reason', 'not_found');");
  });
});

// ===========================================================================
//  2. ONE PREDICATE ANSWERS THE NUMBER
// ===========================================================================

describe('Phase 4: fn_cash_cluster_live_eligible is the predicate, and it is a scalar', () => {
  it('takes (uuid, timestamptz, integer) returning integer, invoker, service_role only', () => {
    // A SCALAR and two statements, rather than the nine of the breakdown,
    // because fn_cash_game_lobby embeds fn_cash_cluster_lightning_state and
    // therefore pays for everything that reader calls on every lobby open.
    // That is the same class of regression the Phase 3 remediation went back
    // for (6.13 ms to 13.97 ms on a five-second path).
    //
    // p_disconnected is the seam for spec Phase 14 (F16, "live eligible
    // population recalculated using authoritative disconnect rules"). It
    // defaults to NULL - "the engine did not say" - so the signature can gain
    // the engine's answer later without changing meaning for any caller that
    // does not have one.
    expect(SCALAR).toBeTruthy();
    expect(
      flat(
        span(CODE, 'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible(', 'AS $fn$')
      )
    ).toBe(
      'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible( p_game_id uuid, ' +
        'p_now timestamptz DEFAULT clock_timestamp(), p_disconnected integer DEFAULT NULL) ' +
        "RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $fn$"
    );
    expect(SCALAR).not.toContain('SECURITY DEFINER');
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamptz, integer) TO service_role;'
    );
    expect(count(CODE, /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_live_eligible/g)).toBe(1);
    expect(SQL).toMatch(
      /COMMENT ON FUNCTION public\.fn_cash_cluster_live_eligible\(uuid, timestamptz, integer\) IS\s+'/
    );
  });

  it('carries the census table predicate and the four-clause filter, and no horse term', () => {
    // LAW 10.5: A HORSE COUNTS EXACTLY LIKE A HUMAN. It is pinned twice in
    // server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts - once
    // against the tick's worklist ("a horse's seat counts exactly like a
    // human's here; the EXISTS reads every seat") and once against the
    // balancer ("LAW 10.5: a horse is balanced exactly like a human") - and
    // both assert the SQL does not mention is_horse. The chips are real, the
    // seat is real and the hand is real, so a threshold that skipped horses
    // would refuse to deal a game that is full of players.
    //
    // The eligibility filter is asserted as ONE EXACT STRING. A set of
    // contains() would pass on a filter that had grown a fifth clause, and a
    // fifth clause here is precisely the change nobody would notice: the
    // number would simply come out lower than the board, which is what
    // everybody already expects it to do.
    expect(flat(span(SCALAR, 'AND ts.left_at IS NULL', 'UNION'))).toBe(
      'AND ts.left_at IS NULL AND ts.user_id IS NOT NULL ' +
        'AND coalesce(ts.is_sitting_out, false) = false ' +
        'AND coalesce(ts.leave_pending, false) = false ' +
        'AND coalesce(ts.stack, 0) > 0 UNION'
    );
    // Said again on its own, because a future edit that loosens the equality
    // above must still meet Law 10.5, and because the file's own proof asserts
    // exactly this against the live body.
    expect(SCALAR).not.toMatch(/horse/i);
    // The table predicate is the census's, so the number and the board can
    // never disagree about which tables belong to the Cluster.
    expect(CENSUS_PREDICATE, 'the census has no recognisable table predicate').toBeTruthy();
    expect(copiesIn(SCALAR), 'the scalar drifted off the census table predicate').toBe(1);
  });

  it('is one count(DISTINCT) over a UNION, and never a UNION ALL', () => {
    // A player seated with chips whose pool session has already been created
    // is in BOTH relations at once, and the window in which that is true is a
    // Phase 5 conversion - precisely when the threshold is being read. Summing
    // two counts would count that human twice and turn Lightning on early.
    //
    // The guard is DOUBLED on purpose, and the file says so: UNION
    // deduplicates the rows, count(DISTINCT) deduplicates the count, and
    // mutation testing showed either alone still answers correctly on every
    // board this estate can build. So neither is pinned here as the
    // load-bearing one - they are pinned as a PAIR, because what the pair buys
    // is that no single edit can reintroduce the double count.
    expect(SCALAR).toMatch(/\bUNION\b/);
    expect(SCALAR).not.toMatch(/\bUNION\s+ALL\b/i);
    expect(SCALAR).toContain('count(DISTINCT u.player_id)::integer');
    // The pool half is the ACTIVE sessions of the CURRENT epoch, which is what
    // makes the two halves the same population at all.
    expect(flat(SCALAR)).toContain(
      'SELECT s.player_id FROM public.lightning_pool_session s ' +
        'WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch ' +
        "AND s.exited_at IS NULL AND s.state = 'active'"
    );
    // The engine's disconnect count is SUBTRACTED, never added, never below
    // zero on either side of the subtraction.
    expect(flat(SCALAR)).toContain('- GREATEST(0, coalesce(p_disconnected, 0)))');
    expect(flat(SCALAR)).toContain('SELECT GREATEST(0,');
    // And it refuses nothing by raising: a missing Cluster yields no row.
    expect(SCALAR).not.toContain('RAISE EXCEPTION');
  });
});

// ===========================================================================
//  3. THE SAME NUMBER, WITH ITS BREAKDOWN
// ===========================================================================

describe('Phase 4: the breakdown explains the number and never recomputes it', () => {
  it('takes the same three arguments, is an invoker, and is service_role only', () => {
    expect(POPULATION).toBeTruthy();
    expect(
      flat(span(CODE, 'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_population(', 'AS $fn$'))
    ).toBe(
      'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_population( p_game_id uuid, ' +
        'p_now timestamptz DEFAULT clock_timestamp(), p_disconnected integer DEFAULT NULL) ' +
        "RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $fn$"
    );
    expect(POPULATION).not.toContain('SECURITY DEFINER');
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_population(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_population(uuid, timestamptz, integer) TO service_role;'
    );
    expect(count(CODE, /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_population/g)).toBe(1);
    expect(SQL).toMatch(
      /COMMENT ON FUNCTION public\.fn_cash_cluster_population\(uuid, timestamptz, integer\) IS\s+'/
    );
    // It refuses a Cluster that does not exist rather than raising, exactly as
    // the thresholds function does, and for the same tick-path reason.
    expect(POPULATION).not.toContain('RAISE EXCEPTION');
    expect(POPULATION).toContain("RETURN jsonb_build_object('ok', false, 'reason', 'not_found');");
  });

  it('CALLS the predicate for live_eligible rather than deriving a second copy of it', () => {
    // This is what makes "one authoritative predicate" literal rather than
    // approximate. The breakdown legitimately re-states the eligibility filter
    // for its OWN figures - seated_eligible and seated_and_pooled are halves,
    // not the answer - so the thing that has to be asserted is not the absence
    // of the filter but the presence of the call in the returned object.
    expect(POPULATION).toMatch(
      /'live_eligible',\s+public\.fn_cash_cluster_live_eligible\(g\.id, p_now, p_disconnected\),/
    );
    // All three arguments forwarded: a call that dropped p_disconnected would
    // report an unadjusted number beside a breakdown that had adjusted, and
    // the file's own proof comparing the two would only catch it when the
    // engine is supplying a count - which is not yet.
    expect(POPULATION).not.toMatch(/fn_cash_cluster_live_eligible\(g\.id\)/);
  });

  it('keeps the census table predicate in all five of its queries, six in the file', () => {
    // THIS IS THE ASSERTION THAT STOPS THE TWO NUMBERS DISAGREEING ABOUT WHICH
    // TABLES ARE IN THE GAME. fn_cash_cluster_census is what
    // fn_cash_cluster_tick reads to decide what a game IS, and
    // tests/one-definition-of-a-games-players.law.test.ts already made three
    // readers agree with it. These are readers four and five of the same
    // tables; they may narrow the SEAT predicate as much as they like, but the
    // moment a TABLE predicate drifts, the board and the threshold are
    // counting two different games.
    //
    // Five copies inside the breakdown - the table count, the seat categories,
    // seated_eligible, the seated_and_pooled overlap and the reserved hold -
    // which is the same five the file's own @live-proof counts in the live
    // body, and one in the scalar makes six. Counted rather than spot-checked,
    // so dropping a clause from ANY copy fails here whichever copy it was.
    expect(copiesIn(POPULATION), 'a query in the breakdown drifted off the census').toBe(5);
    expect(copiesIn(CODE)).toBe(6);
    expect(
      PROOFS.some(
        (p) =>
          p.includes('regexp_matches') &&
          p.includes("AND tb.lifecycle <> ''closed''") &&
          p.endsWith('= 5)')
      ),
      'the file no longer counts its own copies of the census predicate'
    ).toBe(true);
    // And the reserved hold carries it too, which is the difference between
    // "seats held on this game's tables" and "holds on rows that once were".
    const RESERVED = span(POPULATION, 'INTO v_reserved', ';');
    expect(RESERVED).toBeTruthy();
    expect(normalise(RESERVED)).toContain(CENSUS_PREDICATE);
  });

  it('reports the two halves, the overlap and the term that made the identity four-term', () => {
    // THE IDENTITY IS FOUR TERMS, NOT THREE:
    //
    //   GREATEST(0, seated_eligible + lightning_eligible - seated_and_pooled
    //                 - counted.disconnected)  =  live_eligible
    //
    // That is the only shape in which a breakdown can explain a
    // count(DISTINCT) over a union without re-deriving it, and the file proves
    // it against every Cluster. The disconnect term is not decoration: the
    // three counted figures subtract nothing while live_eligible does, so a
    // three-term identity is true only on the p_disconnected IS NULL path -
    // which is every path today and none of them from spec Phase 14 onward.
    for (const key of [
      'seated_total',
      'seated_main',
      'seated_feeder',
      'seated_no_role',
      'seated_eligible',
      'lightning_total',
      'lightning_eligible',
      'lightning_idle',
      'lightning_in_instance',
      'lightning_in_hand',
      'seated_and_pooled',
      'horses',
      'pending_movers',
      'disconnected',
    ]) {
      expect(POPULATION, `counted.${key} is not reported`).toContain(`'${key}',`);
    }
    // Matched on the four TERM NAMES and the floor rather than on one exact
    // concatenation: the proofs read the breakdown once through a LATERAL
    // alias instead of calling it four times inline, and a test that pinned
    // the old spelling would fail on a refactor that changed nothing it cares
    // about. What it cares about is that all four terms are named and that the
    // relation is floored the way live_eligible is.
    expect(IDENTITY_PROOFS.length, 'no proof states the identity at all').toBeGreaterThanOrEqual(1);
    for (const proof of IDENTITY_PROOFS) {
      expect(proof, 'the identity is not floored the way live_eligible is').toContain(
        'GREATEST(0,'
      );
      for (const term of ['seated_eligible', 'lightning_eligible', 'seated_and_pooled']) {
        expect(proof, `the identity proof drops ${term}`).toContain(
          `-> 'counted' ->> '${term}')::integer`
        );
      }
      expect(proof, 'the identity proof drops counted.disconnected').toContain(
        "-> 'counted' ->> 'disconnected')::integer"
      );
      expect(proof).toContain("(x.p ->> 'live_eligible')::integer");
    }
    // The overlap is asked as an EXISTS against the seat half rather than
    // guessed, and the seat half it asks is the eligibility filter again.
    const BOTH = span(POPULATION, 'INTO v_both', ';');
    expect(BOTH).toContain('coalesce(ts.is_sitting_out, false) = false');
    expect(BOTH).toContain('coalesce(ts.leave_pending, false) = false');
    expect(BOTH).toContain('coalesce(ts.stack, 0) > 0');
  });

  it('proves the identity on BOTH disconnect paths, differing only in the third argument', () => {
    // THE MUTATION THIS EXISTS FOR STAYS TRUE ON THE PATH EVERY CLUSTER TAKES
    // TODAY. Drop the disconnect term from the identity and the proof is still
    // true wherever p_disconnected is NULL, because v_disc is 0 there - so a
    // test that only asked "does an identity proof exist" would pass, the
    // migration would apply, every live proof would come back true, and the
    // relation would be wrong from the first day spec Phase 14 supplies a
    // count. The second proof is the one that can see it, and it can only see
    // it while it still carries the term.
    //
    // So: two proofs, one on each path, and they must be the SAME assertion
    // asked twice. Compared by blanking the one thing that is allowed to
    // differ - the call - which is what makes "only in the third argument"
    // checkable rather than a sentence in a comment.
    expect(IDENTITY_PROOFS.length, 'the identity is not proved on both paths').toBe(2);
    const [nullPath, enginePath] = IDENTITY_PROOFS;
    expect(nullPath).toContain('LATERAL (SELECT public.fn_cash_cluster_population(g.id) AS p) x');
    /* The engine path's third argument is DERIVED FROM THE BOARD - one fewer
       than that Cluster's own population - and not a literal. A literal cannot
       discriminate: both sides of the identity are floored at zero, so a fixed
       count larger than the board clamps them both and the proof passes on a
       function that has lost the disconnect term entirely. One-fewer-than-the
       -population makes the answer exactly 1 wherever there is anyone to
       count, which is the only shape that proves anything. A constant zero is
       refused outright, because it is the NULL path spelled differently. */
    expect(enginePath).toMatch(
      /LATERAL \(SELECT public\.fn_cash_cluster_population\(g\.id, clock_timestamp\(\), GREATEST\(0, public\.fn_cash_cluster_live_eligible\(g\.id\) - 1\)\) AS p\) x/
    );
    expect(enginePath).not.toMatch(/fn_cash_cluster_population\(g\.id, clock_timestamp\(\), 0\)/);
    // The engine path must actually exercise a NON-ZERO count, or it is the
    // NULL path spelled differently and proves the same nothing twice.
    expect(enginePath).not.toMatch(/fn_cash_cluster_population\(g\.id, clock_timestamp\(\), 0\)/);
    const blankCall = (proof: string): string =>
      proof.replace(/public\.fn_cash_cluster_population\(.*?\) AS p/, 'POPULATION(<args>) AS p');
    expect(
      blankCall(nullPath),
      'the two identity proofs differ by more than their third argument'
    ).toBe(blankCall(enginePath));
  });

  it('says out loud that its categories do not add up', () => {
    // sit_out, leaving and busted OVERLAP - a seat that is sitting out with no
    // chips is in both - an empty chair is in none of them, and seated_main
    // plus seated_feeder can fall short of seated_total because
    // public.tables.role is nullable and its CHECK constrains only non-NULL
    // values. A reader who subtracted would get a wrong answer and no warning,
    // so the answer carries the warning as a field of its own.
    expect(POPULATION).toContain("'breakdown_is_not_arithmetic', true,");
    for (const key of [
      'sit_out',
      'leaving',
      'busted',
      'empty_chairs',
      'reserved_seat',
      'waitlist_only',
    ]) {
      expect(POPULATION, `excluded.${key} is not reported`).toContain(`'${key}',`);
    }
    // seated_total is OCCUPIED chairs; the empty ones are their own figure and
    // not silently folded into the total the occupancy percentage divides.
    expect(POPULATION).toContain(
      'count(*) FILTER (WHERE ts.user_id IS NOT NULL)::integer,\n    count(*) FILTER (WHERE ts.user_id IS NULL)::integer,'
    );
    expect(POPULATION).toContain(
      'INTO v_seated, v_empty, v_main, v_feeder, v_no_role, v_sit_out, v_leaving, v_busted, v_horses'
    );
    // The role-less seats are counted rather than lost: tables.role is
    // nullable, so main + feeder is not a partition of the seats.
    expect(POPULATION).toContain(
      'count(*) FILTER (WHERE tb.role IS NULL    AND ts.user_id IS NOT NULL)::integer,'
    );
  });

  it('asks for idle directly instead of subtracting two different populations', () => {
    // An earlier cut read GREATEST(0, eligible - in_instance), which subtracts
    // a count of players holding a reservation anywhere in the epoch from a
    // count of ACTIVE pool sessions - two different populations - and hid the
    // crossing under the floor. A player who is eligible and is not in an
    // instance is idle, so that is what is asked.
    const IDLE = span(POPULATION, 'SELECT count(DISTINCT s.player_id)::integer INTO v_l_idle', ';');
    expect(IDLE).toBeTruthy();
    expect(IDLE).toContain('count(DISTINCT s.player_id)::integer');
    expect(IDLE).toContain('NOT EXISTS');
    expect(POPULATION).not.toMatch(/v_l_idle\s*:=/);
    expect(POPULATION).not.toContain('GREATEST(0, v_l_eligible - v_l_instance)');
  });

  it('COUNTS the horses it will not exclude, and never asks a column that does not exist', () => {
    // Reporting the count is the other half of Law 10.5: an operator watching
    // a threshold crossing can see the composition of the population without
    // the threshold treating any part of it differently. is_horse is the
    // column name the two law tests forbid; the seat's horse_id is what this
    // estate actually stores.
    expect(POPULATION).toMatch(/count\(\*\) FILTER \(WHERE ts\.horse_id IS NOT NULL\)::integer/);
    expect(CODE).toMatch(/'horses',\s+v_horses/);
    expect(CODE).not.toContain('is_horse');
  });

  it('names the four things it cannot see, and downgrades its own confidence for them', () => {
    // The specification names thirteen categories; four of them have no
    // representation in PostgreSQL at all. DisconnectEngine's FSM lives in the
    // leader process, ghost BB is stored nowhere by design (20260920235343
    // declined to store per-hand player state, and correctly), and live_viewers
    // holds zero rows. So every answer says which four it is not accounting
    // for rather than counting as though it knew - and when the engine does
    // supply the disconnect count, two of them leave the list and the answer
    // says 'engine' instead of 'partial'.
    const UNKNOWN = span(POPULATION, 'IF p_disconnected IS NULL THEN', 'END IF;');
    expect(UNKNOWN).toBeTruthy();
    expect(UNKNOWN).toContain(
      "v_unknown := jsonb_build_array('disconnected', 'expired_disconnect', 'ghost_bb', 'watching');"
    );
    expect(UNKNOWN).toContain("v_confidence := 'partial';");
    expect(UNKNOWN).toContain("v_unknown := jsonb_build_array('ghost_bb', 'watching');");
    expect(UNKNOWN).toContain("v_confidence := 'engine';");
    // Four elements when the engine did not say, two when it did - counted, so
    // that a fifth or a third would have to be argued for here first.
    expect(
      [...UNKNOWN.matchAll(/jsonb_build_array\(([^)]*)\)/g)].map((m) => m[1].split(',').length)
    ).toEqual([4, 2]);
    expect(UNKNOWN).toContain('v_disc := GREATEST(0, p_disconnected);');
    expect(POPULATION).toContain("'unknown',    v_unknown,");
    expect(POPULATION).toContain("'confidence', v_confidence);");
  });
});

// ===========================================================================
//  4. THE ONE READER CARRIES THE VERDICT
// ===========================================================================

/** The keys one jsonb_build_object names, in order, ignoring the header above it. */
const keysOf = (body: string): string[] => {
  const obj = body.slice(body.indexOf('jsonb_build_object('));
  return [...new Set([...obj.matchAll(/'(\w+)',/g)].map((m) => m[1]))];
};

describe('Phase 4: the Lightning reader gains the verdict and loses no field', () => {
  it('keeps every field the previous two migrations gave it', () => {
    // fn_cash_game_lobby EMBEDS this function - that is how 20260920234647
    // answered "a reader nothing reads is a reader nothing constrains" - so a
    // CREATE OR REPLACE that silently dropped a key compiles, applies, passes
    // every other check in the file and breaks the lobby. This body has now
    // been re-cut four times, which is four chances to lose one. The
    // previous body is read out of the two migrations that wrote it rather
    // than transcribed here, so this keeps meaning what it says if either is
    // ever re-cut in turn.
    const prior = [
      '20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql',
      '20260920234647_lightning_phase_1_remediation_the_lobby_reads_one_lightning_.sql',
    ].map((f) =>
      keysOf(
        span(
          fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'),
          'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)',
          '$$;'
        )
      )
    );
    // 20260920234647 says its body is byte-identical to 20260920172736 and
    // only the security attribute moves; if that ever stopped being true the
    // union would be the honest thing to compare against, so it is checked
    // rather than assumed.
    expect(prior[0]).toEqual(prior[1]);
    expect(prior[0]).toEqual([
      'game_id',
      'cluster_mode',
      'cluster_epoch',
      'lightning_enabled',
      'must_move',
      'enabled',
      'handedness',
      'open_cluster_sessions',
    ]);
    expect(STATE).toBeTruthy();
    for (const key of prior[0]) {
      expect(STATE, `fn_cash_cluster_lightning_state dropped '${key}'`).toContain(`'${key}',`);
    }
    // And the open-session subselect is the same question, not merely the same
    // key name: a key that survived as a null would break the lobby just as
    // thoroughly as one that vanished.
    expect(flat(STATE)).toContain(
      "'open_cluster_sessions', (SELECT count(*) FROM public.cash_player_session s " +
        'WHERE s.cluster_id = g.id AND s.closed_at IS NULL)'
    );
    // The file asserts the same thing again from the catalogue after it
    // applies, which is the half no source test can do.
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the re-created reader dropped a field the lobby already reads'/
    );
  });

  it('reads the SCALAR and never names the breakdown', () => {
    // A lobby open must not pay for nine statements of explanation nobody
    // asked for. An operator who wants the categories asks
    // fn_cash_cluster_population directly; the reader the browser reaches asks
    // the two-statement predicate. Asserted as an ABSENCE of the breakdown's
    // name in the comment-stripped body, because the prose above the function
    // legitimately explains why it is not there.
    expect(STATE).toContain(
      'CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_live_eligible(g.id) AS live) n'
    );
    expect(STATE).toContain(
      'CROSS JOIN LATERAL (SELECT public.fn_cash_cluster_lightning_thresholds(g.id) AS th) t'
    );
    expect(STATE).not.toContain('fn_cash_cluster_population');
    expect(keysOf(STATE)).not.toContain('population');
    for (const key of ['thresholds', 'verdict']) {
      expect(keysOf(STATE), `the reader does not carry '${key}'`).toContain(key);
    }
    // LATERAL, so each is evaluated once per game row rather than once per
    // reference: the verdict refers to the number four times.
    expect(count(STATE, /CROSS JOIN LATERAL/g)).toBe(2);
    expect(STATE).toContain('STABLE');
    expect(STATE).toContain('SECURITY INVOKER');
    // 20260920234647 exists in part to flip this function OFF definer, and it
    // carries a @live-proof for `NOT p.prosecdef`. A re-create that said
    // DEFINER again - or that left the clause off and relied on the default -
    // would quietly undo that whole migration.
    expect(STATE).not.toContain('SECURITY DEFINER');
    expect(STATE).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;'
    );
    // No disconnect count reaches this path, so the number here is always the
    // partial one and the answer says so rather than leaving it to be assumed.
    expect(STATE).toContain("'confidence', 'partial')");
  });

  it('turns ON at >= and OFF at <=, which is the specification asymmetry and not a typo', () => {
    // ON is "population >= ON threshold"; OFF is "population <= OFF
    // threshold". The asymmetry is the specification's own, and it is exactly
    // what makes 12 pending-off on a six-max game while 13 is not - and 18
    // pending-on while 17 remains MUST-MOVE. Both operators are asserted
    // explicitly, and each arm is checked for the ABSENCE of the strict form,
    // because `>` instead of `>=` is a one-character edit that moves every
    // threshold in the estate by one player and breaks nothing that compiles.
    const ON_ARM = span(STATE, "'would_turn_on',", "'would_turn_off',");
    const OFF_ARM = span(STATE, "'would_turn_off',", "'live_eligible',");
    expect(ON_ARM).toBeTruthy();
    expect(OFF_ARM).toBeTruthy();
    expect(flat(ON_ARM)).toContain("n.live >= (t.th ->> 'on')::integer");
    expect(ON_ARM).not.toMatch(/n\.live >[^=]/);
    expect(ON_ARM).not.toContain('<=');
    expect(flat(OFF_ARM)).toContain("n.live <= (t.th ->> 'off')::integer");
    expect(OFF_ARM).not.toMatch(/n\.live <[^=]/);
    expect(OFF_ARM).not.toContain('>=');
    // ON is gated on enabled and OFF is not, deliberately: a disabled Cluster
    // must not be allowed INTO Lightning and must always be able to drain OUT.
    //
    // SUPERSEDED, AND STILL TRUE OF THIS FILE. 20260921142954 widened both
    // filters by one state, to IN ('must_move', 'pending_on') and IN
    // ('lightning', 'pending_off'), because the specification re-asks both
    // questions in a PENDING state and a verdict that answered false there
    // would abort every conversion at its own safety re-check. The exact
    // strings below are still what THIS migration says, which is what this
    // file exists to pin; the live body is pinned by
    // tests/lightning-phase-4-remediation.test.ts. Left as an equality on
    // purpose: an edit to 20260921064717 is a rewrite of history, and this is
    // what refuses one.
    expect(flat(ON_ARM)).toContain(
      "g.lightning_enabled AND g.cluster_mode = 'must_move' AND coalesce(g.enabled, false)"
    );
    expect(flat(OFF_ARM)).toBe(
      "'would_turn_off', g.cluster_mode = 'lightning' AND n.live <= (t.th ->> 'off')::integer, 'live_eligible',"
    );
    // Headroom both ways, so a dashboard never has to re-derive the comparison.
    expect(STATE).toContain("'to_on',  GREATEST(0, (t.th ->> 'on')::integer - n.live),");
    expect(STATE).toContain("'to_off', GREATEST(0, n.live - (t.th ->> 'off')::integer),");
  });
});

// ===========================================================================
//  5. SCOPE, SAFETY AND PROOF
// ===========================================================================

describe('Phase 4: it converts nothing, and proves what it says', () => {
  it('writes no mode, no epoch and no Lightning row', () => {
    // The verdict this phase produces is DESCRIPTIVE. Spec Phase 5 is what
    // acts on it, and nothing new runs on the tick's hot path until it does.
    //
    // ABSENCES ARE NOT A TEST. A file containing nothing but `BEGIN;` and
    // `COMMIT;` passes every not.toMatch below, so each is paired with a
    // presence that proves this is the file under test and that it did the
    // work whose absence of side effects is being asserted.
    expect(CODE).toContain('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible(');
    expect(CODE).toContain('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_population(');
    expect(CODE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)'
    );
    expect(count(CODE, /CREATE OR REPLACE FUNCTION/g)).toBe(5);
    expect(CODE.length).toBeGreaterThan(10000);

    // cluster_mode and cluster_epoch are READ - the reader reports them and
    // both Lightning halves key off the epoch - and never written.
    expect(CODE).toMatch(/'cluster_mode',\s+g\.cluster_mode/);
    expect(CODE).toContain('s.cluster_epoch = g.cluster_epoch');
    expect(CODE).not.toMatch(/UPDATE\s+public\.cash_games\b/i);
    expect(CODE).not.toMatch(/\bSET\s+cluster_mode\b/i);
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+public\.cash_cluster_epoch\b/i);

    // The Lightning relations are read, five of them, and written to by
    // nothing here.
    expect(CODE).toContain('FROM public.lightning_pool_session s');
    expect(CODE).toContain('FROM public.lightning_reservation r');
    expect(CODE).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.lightning_/i);

    // And nothing writes anything at all: no DML verb survives the strip.
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('is one transaction, as the production DDL policy requires', () => {
    // Every DDL statement fires Supabase's schema-cache reload, which takes
    // about 28 seconds on this database, so five loose CREATEs plus their
    // grants and comments would mean fifteen reloads.
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE).toContain("SET LOCAL lock_timeout = '8s';");
  });

  it('asks the catalogue for both handedness bands, so the default check is not half-vacuous', () => {
    // The band checks above it are each wrapped in `IF v_id IS NOT NULL`, so
    // on a database with no six-max Cluster the 18/12 check proves exactly
    // nothing and passes. This is the line that refuses that: BOTH bands must
    // have a live Cluster, or the file says so instead of committing on half
    // a proof. The two LIMIT 1s are ordered, so which Cluster answers is not
    // left to the planner.
    expect(READ_BACK).toBeTruthy();
    expect(READ_BACK).toContain(
      'IF NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness <= 6)'
    );
    expect(READ_BACK).toContain(
      'OR NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness > 6) THEN'
    );
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'one of the two handedness bands has no live cluster, so the check above proved half of what it says'/
    );
    expect(READ_BACK).toContain('WHERE handedness <= 6 ORDER BY created_at, id LIMIT 1;');
    expect(READ_BACK).toContain('WHERE handedness > 6 ORDER BY created_at, id LIMIT 1;');
    expect(READ_BACK).toContain(
      "IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 OR (v_th ->> 'off')::integer IS DISTINCT FROM 12 THEN"
    );
    expect(READ_BACK).toContain(
      "IF (v_th ->> 'on')::integer IS DISTINCT FROM 27 OR (v_th ->> 'off')::integer IS DISTINCT FROM 18 THEN"
    );
  });

  it('checks the verdict against its own inputs on every cluster, not against a board', () => {
    // An earlier cut asserted `to_on = 18` on whichever six-max Cluster LIMIT
    // 1 returned, which holds only if that Cluster has exactly zero eligible
    // players - a property of the DATA, unordered, that one seated player
    // would have turned into a refusal to apply. What must be true of the CODE
    // is the RELATIONSHIP between the verdict and its inputs, and it is asked
    // of every Cluster. No headcount constant appears anywhere in the file.
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the verdict disagrees with its own inputs on % cluster\(s\)'/
    );
    expect(READ_BACK).toContain('IS DISTINCT FROM GREATEST(0, y.on_t - y.live)');
    expect(READ_BACK).toContain('IS DISTINCT FROM GREATEST(0, y.live - y.off_t)');
    expect(SQL).not.toMatch(/count\(\*\) = \d\d+/);
    // The breakdown's number IS the predicate's number, on every Cluster,
    // which is what "one authoritative predicate" has to mean to be worth
    // saying at all.
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the breakdown and the predicate disagree on % cluster\(s\)'/
    );
    // The population is never larger than the rows it was computed from, never
    // larger than the board count, and nothing converted.
    expect(READ_BACK).toContain('public.fn_cash_cluster_census(g.id)');
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION '% cluster\(s\) report more eligible seats than the board counts seats at all'/
    );
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION '% cluster\(s\) left must_move during a phase that converts nothing'/
    );
  });

  it('declares live proofs, every one of them a single parenthesised SELECT', () => {
    // The harness wraps each in a SELECT and expects a single true-ish scalar,
    // so a proof that is two statements, or one that does not close its own
    // parenthesis, is not a proof at all - it is a syntax error at verify time.
    // A FLOOR, NEVER AN EQUALITY. A count of anything written down in prose is
    // exactly the thing that has gone stale three times in this file already.
    expect(PROOFS.length).toBeGreaterThanOrEqual(20);
    for (const p of PROOFS) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
    }
    const all = PROOFS.join('\n');
    expect(all).toContain('fn_cash_cluster_live_eligible');
    expect(all).toContain('fn_cash_cluster_population');
    expect(all).toContain('fn_cash_cluster_lightning_thresholds');
  });

  it('strips comments from every function body it text-matches against', () => {
    // THE REGRESSION TEST FOR A DEFECT CLASS, NOT FOR AN INCIDENT. Three
    // proofs in this one migration went false for the same reason: the body
    // they read with pg_get_functiondef quoted, IN A COMMENT, the exact string
    // the proof forbade. `position('horse' in <the scalar>) = 0` is false
    // while the scalar's header explains why a horse is not excluded; the
    // comment is the RIGHT thing to have written and the proof was the wrong
    // way to ask. A proof that matches text against a body must therefore see
    // the body the way this test file sees the migration - comments removed -
    // or it is asserting something about the prose.
    //
    // So: any proof that calls pg_get_functiondef AND applies a text operator
    // to the result must also call regexp_replace. This is the same strip the
    // migration spells as '--[^' || chr(10) || ']*'.
    const TEXT_OPERATORS = ['position(', ' ~ ', ' !~ ', 'regexp_matches'];
    // ONE documented exception, named by its own text so it cannot silently
    // widen: a POSITIVE position(...) > 0 check for the scalar's name inside
    // the reader. A comment can only ever make that check PASS when it should
    // have failed - it can mask a removal - and can never invent a failure, so
    // it does not need the wrapper. Every negative check does.
    const EXEMPT = "position('fn_cash_cluster_live_eligible' in pg_get_functiondef(";
    const exempted: string[] = [];
    for (const p of PROOFS) {
      if (!p.includes('pg_get_functiondef')) continue;
      if (!TEXT_OPERATORS.some((op) => p.includes(op))) continue;
      if (p.includes(EXEMPT)) {
        exempted.push(p);
        continue;
      }
      expect(p, `this proof reads a body as text without stripping its comments: ${p}`).toContain(
        'regexp_replace'
      );
    }
    // Exactly one exemption, and it asserts only presence: an `= 0` inside the
    // exempted line would be a negative check riding on the exception.
    expect(exempted.length).toBe(1);
    expect(exempted[0]).not.toMatch(/=\s*0/);
    expect(exempted[0]).toContain('> 0');
    // And the rule is not vacuous: six proofs actually take the wrapper.
    expect(PROOFS.filter((p) => p.includes('regexp_replace')).length).toBeGreaterThanOrEqual(6);
    expect(PROOFS.join('\n')).toContain("'--[^' || chr(10) || ']*', '', 'g'");
  });
});
