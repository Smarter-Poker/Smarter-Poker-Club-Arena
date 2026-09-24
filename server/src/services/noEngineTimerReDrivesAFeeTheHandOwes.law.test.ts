/**
 * ===========================================================================
 *  LAW: NO ENGINE TIMER RE-DRIVES A FEE THE HAND ALREADY OWES (2026-09-22)
 * ===========================================================================
 *
 * Owner, binding: never add or rely on a cron, watcher, reconciler or repair
 * loop to compensate for a defect (CLAUDE.md 10.12, policy v2.9).
 *
 * Until this change the engine ran four repair loops on its own timers:
 *
 *   - the fee cycle's hourly requeueUnbankedCashRake(6, 10, 200), which filed
 *     an equal-split (DEALT_EQUAL) claim for any raked cash hand with no rake
 *     record after ten minutes. It could not see the settlement envelope, so a
 *     merely LATE envelope lost the race: atomic_distribute_rake keeps the
 *     first write for a hand, and the hand's weighted per-player attribution
 *     was gone for good;
 *   - the 30-minute fn_requeue_unbanked_fees pass in discoverTournaments,
 *     which turned unqueueable-fee alerts back into queue rows;
 *   - the five-minute queue drain's rake and BBJ-drop re-drive, and the
 *     hourly BBJ self-heal (fn_bbj_repair_unbanked) beside it;
 *   - the hourly bomb-pot award-unit backfill.
 *
 * Every one compensated for a split write that no longer exists. Since
 * 2026-09-09 21:56 UTC the only hand door the engine can reach,
 * fn_ca_commit_hand_settlement, carries the rake and the BBJ drop in the
 * hand's post-commit envelope and refuses a hand whose envelope disagrees with
 * its fees; fn_ca_process_hand_post_commit_obligations banks both in one
 * transaction. A bomb-pot hand cannot commit without its award units
 * (constraint trigger zz_ca_bomb_hand_keeps_its_award_units).
 *
 * MEASURED ON PRODUCTION 2026-09-24, before the loops were removed, each
 * figure read through the Supabase MCP at the time given:
 *
 *   03:46 UTC  57,377 raked cash hands in 24h, 0 without an atomic commit,
 *              0 with a null envelope
 *   03:46 UTC  173,098 cash rake records in 3 days, 0 banked more than five
 *              minutes after their hand, worst lag 2m04s
 *   03:21 UTC  172,958 raked cash hands in 3 days, 0 with no rake record
 *   03:15 UTC  fn_requeue_unbanked_cash_rake candidates: 0 at 6h, 48h, 7d and
 *              14d. 8 all time, the newest 2026-08-22 21:27 UTC, every one
 *              older than the cutover
 *   03:17 UTC  fn_requeue_unbanked_fees candidates: 0. No unresolved
 *              FeeReconciler.queue_failed alert; the last one ever was raised
 *              2026-09-08 03:08 UTC. fee_requeue_log: 0 rows in 7d and 14d,
 *              last real re-queue 2026-08-31 14:50 UTC
 *   03:17 UTC  pending_fee_distributions: 0 unresolved rows of any kind; the
 *              last rake claim ever was queued 2026-09-08 17:30 UTC
 *   03:22 UTC  fn_bbj_repair_unbanked candidates: 0 at 48h; 0 marker rows in
 *              7d and 14d, last 2026-09-08 17:17 UTC
 *   03:18 UTC  bomb hands missing award units: 0, all time, against 70,534
 *              award units written in the preceding 7 days
 *
 * What this pins:
 *   1. the source guarantees the removal rests on. If a later migration
 *      relaxes either door, this fails, and the answer is to restore the
 *      guarantee, not the timer;
 *   2. the engine builds that envelope with both fees in it;
 *   3. no engine runtime file calls a repair-, backfill-, re-drive-, heal-,
 *      catch-up- or re-queue-shaped RPC except the named debt below, which may
 *      only get shorter;
 *   4. the queue drain reads jackpot payout claims only, and FeeReconciler
 *      exports nothing repair-shaped and never banks rake or a BBJ drop;
 *   5. the fee cycle keeps its six read-only audits and its jackpot claim
 *      drain, and imports nothing else from FeeReconciler.
 *
 * TypeScript is read as a syntax tree and SQL with its comments removed: both
 * files explain in prose what was retired, and an RPC name is code while a
 * sentence about one is not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SERVER_SRC = resolve(__dirname, '..');
const REPO = resolve(SERVER_SRC, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

// ─── helpers ────────────────────────────────────────────────────────────────

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

/** Every node under `root`, depth first. */
function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** `x.rpc('name', ...)` calls whose name is a literal, with where they are. */
function rpcCalls(sf: ts.SourceFile): Array<{ name: string; line: number }> {
  return nodes(sf)
    .filter(
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'rpc' &&
        n.arguments.length > 0 &&
        ts.isStringLiteralLike(n.arguments[0])
    )
    .map((call) => ({
      name: (call.arguments[0] as ts.StringLiteralLike).text,
      line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
    }));
}

/** The body of a function declaration or class method, by name. */
function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  const hits = nodes(sf).filter(
    (n): n is ts.FunctionDeclaration | ts.MethodDeclaration =>
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name !== undefined &&
      n.name.getText(sf) === name &&
      n.body !== undefined
  );
  expect(hits, `exactly one declaration of ${name}`).toHaveLength(1);
  return hits[0];
}

/** The names of every function called directly by identifier inside `root`. */
function calledIdentifiers(root: ts.Node): Set<string> {
  const out = new Set<string>();
  for (const n of nodes(root)) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.add(n.expression.text);
  }
  return out;
}

/**
 * A call chain as a list, innermost first: supabase.from('t').select('x').eq('a', 'b')
 * becomes [from('t'), select('x'), eq('a','b')], each with its literal arguments.
 */
function chainOf(call: ts.CallExpression): Array<{ method: string; args: string[] }> {
  const links: Array<{ method: string; args: string[] }> = [];
  let cur: ts.Expression = call;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    links.unshift({
      method: cur.expression.name.text,
      args: cur.arguments.map((a) => (ts.isStringLiteralLike(a) ? a.text : a.getText())),
    });
    cur = cur.expression.expression;
  }
  return links;
}

/** A camelCase or snake_case identifier as lower-case underscore-separated words. */
const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** SQL with its comments blanked. String literals stay: a refusal reason is code. */
const sqlCode = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/**
 * The migration in force for `fn`: the LAST one whose code declares it, and
 * the body of its last declaration there, between its own dollar quotes.
 * Throws rather than returning nothing: a pin on an empty string passes.
 */
function latestDeclaring(fn: string): { name: string; body: string } {
  const declares = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`,
    'gi'
  );
  for (const name of migrationNames().reverse()) {
    const code = sqlCode(readFileSync(join(MIGRATIONS, name), 'utf8'));
    const starts = [...code.matchAll(declares)].map((m) => m.index ?? -1);
    if (starts.length === 0) continue;
    const at = starts[starts.length - 1];
    const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(code.slice(at));
    if (!tag) throw new Error(`${fn} in ${name} has no dollar-quoted body`);
    const open = at + tag.index + tag[0].length;
    const close = code.indexOf(tag[1], open);
    if (close < 0) throw new Error(`${fn} in ${name} has no closing ${tag[1]}`);
    return { name, body: code.slice(open, close) };
  }
  throw new Error(`no migration declares public.${fn}`);
}

function runtimeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') runtimeFiles(path, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

// ─── 1. the guarantees the removal rests on ────────────────────────────────

describe('the hand door owes the fees, so no timer has to', () => {
  const door = latestDeclaring('fn_ca_commit_hand_settlement');

  it('demands both fee slots in the envelope and refuses a hand without them', () => {
    expect(door.body).toMatch(/NOT \(p_post_commit_obligations \? 'rake'\)/);
    expect(door.body).toMatch(/NOT \(p_post_commit_obligations \? 'bbj_contribution'\)/);
    expect(door.body).toContain('atomic hand commit refused (invalid_post_commit_obligations)');
  });

  it('refuses a raked hand whose envelope does not carry its rake, and the same for the BBJ drop', () => {
    const code = door.body.replace(/\s+/g, ' ');
    expect(code).toContain(
      "(COALESCE(p_rake, 0) > 0) IS DISTINCT FROM (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')"
    );
    expect(code).toContain(
      "(COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')"
    );
    expect(code).toContain('atomic hand commit refused (post_commit_fee_mismatch)');
  });

  it('a bomb-pot hand cannot commit without its award units, and nothing detached that guard', () => {
    const guard = latestDeclaring('fn_ca_bomb_hand_keeps_its_award_units');
    expect(guard.body).toMatch(/IF v_n = 0 THEN\s+RAISE EXCEPTION/);

    const attach =
      /CREATE\s+CONSTRAINT\s+TRIGGER\s+zz_ca_bomb_hand_keeps_its_award_units\s+AFTER\s+INSERT\s+ON\s+public\.hand_history\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i;
    const detach =
      /(DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?zz_ca_bomb_hand_keeps_its_award_units|DISABLE\s+TRIGGER\s+zz_ca_bomb_hand_keeps_its_award_units)/i;
    const names = migrationNames();
    const attachedIn = names.filter((n) =>
      attach.test(sqlCode(readFileSync(join(MIGRATIONS, n), 'utf8')))
    );
    expect(attachedIn.length, 'a migration attaches the bomb guard').toBeGreaterThan(0);
    const lastAttach = attachedIn[attachedIn.length - 1];
    const detachedAfter = names
      .filter((n) => n > lastAttach)
      .filter((n) => detach.test(sqlCode(readFileSync(join(MIGRATIONS, n), 'utf8'))));
    expect(detachedAfter, 'no migration after the attach removes the guard').toEqual([]);
  });
});

// ─── 2. the engine writes the fees into that envelope ──────────────────────

describe('the engine hands its fees to the envelope', () => {
  it('the settlement envelope carries a rake slot and a BBJ-drop slot', () => {
    const sf = parse(join(SERVER_SRC, 'engine', 'ServerTableEngineSettlement.ts'));
    const decl = nodes(sf).filter(
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) && n.name.getText(sf) === 'postCommitObligations'
    );
    expect(decl, 'one postCommitObligations').toHaveLength(1);
    const literals = nodes(decl[0]).filter(ts.isObjectLiteralExpression);
    const keys = new Set(
      literals.flatMap((o) =>
        o.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf)))
      )
    );
    expect(keys.has('rake')).toBe(true);
    expect(keys.has('bbj_contribution')).toBe(true);
  });
});

// ─── 3. no engine code calls a repair-shaped RPC ───────────────────────────

/**
 * Debt, not a door. Each entry names why it is not a correctness repair, and
 * this list may only get shorter.
 */
const NAMED_DEBT: Record<string, string> = {
  fn_union_rake_rollup_catchup_all:
    'RakebackSettlerService precomputes union rake day rollups to keep that work out of ' +
    'the Monday settlement transaction; a stale day is recomputed at read time, so ' +
    'correctness never waits on it. The name is the debt.',
};

describe('no engine runtime code calls a repair-shaped RPC', () => {
  it('none, apart from the named debt', async () => {
    const { isBandAidName } = (await import(
      /* @vite-ignore */ pathToFileURL(join(REPO, 'scripts', 'ci', 'check-no-new-band-aids.mjs'))
        .href
    )) as { isBandAidName: (name: string) => boolean };
    const repairShaped = (name: string): boolean =>
      isBandAidName(name) || /(^|_)re_?queue(_|$)/.test(words(name));

    // The retired ones, spelled out, so the rule is known to cover them.
    for (const retired of [
      'fn_requeue_unbanked_cash_rake',
      'fn_requeue_unbanked_fees',
      'fn_bbj_repair_unbanked',
      'fn_redrive_unbanked_rake',
      'fn_rake_repair_unbanked',
      'fn_backfill_bomb_pot_award_units',
      'fn_backfill_bomb_multi_winner_units',
    ]) {
      expect(repairShaped(retired), retired).toBe(true);
    }

    const found: Array<{ name: string; where: string }> = [];
    for (const path of runtimeFiles(SERVER_SRC)) {
      const text = readFileSync(path, 'utf8');
      if (!/\.rpc\s*\(/.test(text)) continue;
      for (const call of rpcCalls(parse(path))) {
        if (repairShaped(call.name)) {
          found.push({ name: call.name, where: `${relative(SERVER_SRC, path)}:${call.line}` });
        }
      }
    }

    const undeclared = found.filter((f) => !(f.name in NAMED_DEBT));
    expect(
      undeclared.map((f) => `${f.name} at ${f.where}`),
      'an engine timer is calling a repair. Fix the writer that leaves the gap instead ' +
        '(CLAUDE.md 10.12); a repair job firing is an incident, not a success.'
    ).toEqual([]);

    // A paid-off debt leaves the list in the same change.
    const stillCalled = new Set(found.map((f) => f.name));
    expect(Object.keys(NAMED_DEBT).filter((n) => !stillCalled.has(n))).toEqual([]);
  });
});

// ─── 4. the queue drain completes jackpot claims and nothing else ─────────

describe('FeeReconciler completes jackpot claims and re-drives no fee', () => {
  const sf = parse(join(SERVER_SRC, 'services', 'FeeReconciler.ts'));

  /**
   * The one repair-shaped export left, and why it is still here. Debt, not a
   * door: this list may only get shorter.
   */
  const EXPORT_DEBT: Record<string, string> = {
    reconcilePendingFees:
      'The five-minute jackpot claim drain. A bbj_payout claim is written ahead of the ' +
      'payout and left open when the maintenance freeze defers it or the process dies ' +
      'before paying, and this is the only thing that completes it. It retires when the ' +
      'payout is completed by its own causal chain (the thaw event, one bounded boot ' +
      'drain, or the hand transaction itself); see the FeeReconciler entry in ' +
      'docs/BAND-AIDS-REGISTER.md.',
  };

  it('exports nothing repair-shaped beyond the named debt', async () => {
    const { isBandAidName } = (await import(
      /* @vite-ignore */ pathToFileURL(join(REPO, 'scripts', 'ci', 'check-no-new-band-aids.mjs'))
        .href
    )) as { isBandAidName: (name: string) => boolean };
    const exported = nodes(sf)
      .filter(
        (n): n is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(n) &&
          n.name !== undefined &&
          (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0
      )
      .map((n) => n.name!.text);
    const repairShaped = exported.filter(
      (n) => isBandAidName(words(n)) || /(^|_)re_?queue(_|$)/.test(words(n))
    );
    expect(repairShaped.filter((n) => !(n in EXPORT_DEBT))).toEqual([]);
    // A paid-off debt leaves the list in the same change.
    expect(Object.keys(EXPORT_DEBT).filter((n) => !exported.includes(n))).toEqual([]);
  });

  it('the drain asks the queue for bbj_payout claims only', () => {
    const drain = functionNamed(sf, 'reconcilePendingFees');
    const reads = nodes(drain)
      .filter(ts.isCallExpression)
      .map(chainOf)
      .filter(
        (chain) =>
          chain.some((l) => l.method === 'from' && l.args[0] === 'pending_fee_distributions') &&
          chain.some((l) => l.method === 'select')
      );
    // The outermost call of the read statement carries the whole chain.
    const longest = reads.reduce((a, b) => (b.length > a.length ? b : a), [] as (typeof reads)[0]);
    expect(longest.length, 'the drain reads the queue').toBeGreaterThan(0);
    expect(longest).toContainEqual({ method: 'eq', args: ['kind', 'bbj_payout'] });
  });

  it('never banks rake or a BBJ drop: no atomic_distribute_rake, no logBBJCollection, no rpc at all', () => {
    const drain = functionNamed(sf, 'reconcilePendingFees');
    expect(rpcCalls(sf).map((c) => c.name)).not.toContain('atomic_distribute_rake');
    expect(
      nodes(drain).filter(
        (n) =>
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'rpc'
      )
    ).toEqual([]);
    const identifiers = new Set(
      nodes(sf)
        .filter(ts.isIdentifier)
        .map((i) => i.text)
    );
    expect(identifiers.has('logBBJCollection')).toBe(false);
  });
});

// ─── 5. the fee cycle keeps its observers and loses its repairs ───────────

describe('the engine fee cycle keeps its audits and nothing else', () => {
  const sf = parse(join(SERVER_SRC, 'GameServer.ts'));
  const AUDITS = [
    'auditBBJDrift',
    'auditRakeAttributionDrift',
    'auditSatelliteConservation',
    'auditPrizeDisbursement',
    'auditDoublePaidObligations',
    'auditGuaranteesKept',
  ];

  it('imports only the jackpot claim drain and read-only audits from FeeReconciler', () => {
    const imports = sf.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === './services/FeeReconciler.js'
    );
    expect(imports).toHaveLength(1);
    const bindings = imports[0].importClause?.namedBindings;
    expect(bindings && ts.isNamedImports(bindings)).toBe(true);
    const names = (bindings as ts.NamedImports).elements.map((e) => e.name.text);
    expect(names.filter((n) => n !== 'reconcilePendingFees' && !/^audit[A-Z]/.test(n))).toEqual([]);
    for (const audit of AUDITS) expect(names, audit).toContain(audit);
  });

  it('the cycle calls the drain and every audit, and makes no rpc of its own', () => {
    const cycle = functionNamed(sf, 'startFeeReconciler');
    const called = calledIdentifiers(cycle);
    expect(called.has('reconcilePendingFees')).toBe(true);
    for (const audit of AUDITS) expect(called.has(audit), audit).toBe(true);
    expect(
      nodes(cycle).filter(
        (n) =>
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'rpc'
      )
    ).toEqual([]);
  });
});

// ─── 6. no later migration puts a retired fee repair back on a timer ───────

/**
 * Sections 3 to 5 keep the ENGINE honest. They cannot see a migration, and a
 * migration is the other way these loops come back: `cron.schedule` a job whose
 * body calls the retired function, and the repair is running again with no
 * TypeScript changed at all.
 *
 * scripts/ci/check-no-new-band-aids.mjs is keyed on the NAME of the job and of
 * the function it declares. Neither covers this. `requeue` is not one of its
 * BAND_AID_WORDS, and `scheduledJobs()` reads the job name only, so
 *
 *   SELECT cron.schedule('ca-fee-sweep-30m', '*''/30 * * * *',
 *                        $$ SELECT public.fn_requeue_unbanked_fees(true, 500); $$);
 *
 * walks past every existing gate: an innocent name running a retired repair.
 * This section reads the BODY.
 *
 * MEASURED ON PRODUCTION 2026-09-24 03:26 UTC, at two levels of indirection:
 * no active pg_cron job reaches any of these functions. The single apparent
 * hit was fn_rake_bbj_audit naming fn_rake_repair_unbanked in a COMMENT, which
 * is why the detector below reads comment-stripped SQL, and why it self-tests
 * against both the shape it must catch and the prose it must not.
 *
 * THE BASELINE IS NOT A LOOPHOLE. Five migrations from 2026-08-31 and
 * 2026-09-06 legitimately scheduled these repairs when they were the policy;
 * rewriting history is not the point, and a law that fails on its own past is
 * a law people delete. The rule binds every migration written from here.
 */
const RETIRED_TIMER_PATHS = [
  'fn_requeue_unbanked_cash_rake',
  'fn_requeue_unbanked_fees',
  'fn_bbj_repair_unbanked',
  'fn_backfill_bomb_pot_award_units',
];

/** The last migration on the branch that retired these loops in the engine. */
const SCHEDULING_BASELINE = '20260922150932_the_rake_audit_says_who_may_run_it.sql';

/**
 * SQL split into statements, respecting dollar-quoted bodies and single-quoted
 * literals, so a `;` inside a `$$ ... $$` job body does not end the statement
 * and truncate the very text this reads.
 */
function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === ';') {
      out.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += sql[i];
    i += 1;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * The job names this SQL schedules whose body reaches a retired repair path.
 * Comments are stripped first: a migration header explaining what it retires
 * names these functions in prose, and prose is not a schedule.
 */
function schedulesReachingRetired(sql: string): string[] {
  const hits: string[] = [];
  for (const stmt of sqlStatements(sqlCode(sql))) {
    if (!/cron\.schedule\s*\(/i.test(stmt)) continue;
    if (!RETIRED_TIMER_PATHS.some((fn) => stmt.includes(fn))) continue;
    const named = /cron\.schedule\s*\(\s*'([^']+)'/i.exec(stmt);
    hits.push(named ? named[1] : stmt.trim().slice(0, 80));
  }
  return hits;
}

describe('no migration puts a retired fee repair back on a timer', () => {
  it('the detector catches the exact shape it must catch, and not prose', () => {
    // The shape: an innocent job name running a retired repair in its body.
    // The cron expression is built rather than typed so this file never
    // contains a literal that reads as a schedule.
    const every30 = ['*', '/30 * * * *'].join('');
    expect(
      schedulesReachingRetired(
        `SELECT cron.schedule('ca-fee-sweep-30m', '${every30}',` +
          ` $$ SELECT public.fn_requeue_unbanked_fees(true, 500); $$);`
      )
    ).toEqual(['ca-fee-sweep-30m']);

    // A `;` inside the body must not truncate the statement before the name.
    expect(
      schedulesReachingRetired(
        `SELECT cron.schedule('ca-rake-sweep', '${every30}',` +
          ` $$ SELECT 1; SELECT public.fn_requeue_unbanked_cash_rake(6, 10, 200); $$);`
      )
    ).toEqual(['ca-rake-sweep']);

    // Prose naming a retired path is not a schedule.
    expect(
      schedulesReachingRetired(
        `-- fn_requeue_unbanked_fees is retired; nothing calls it.\n` +
          `/* fn_bbj_repair_unbanked too. */\n` +
          `SELECT cron.schedule('ca-something-else', '${every30}', $$ SELECT 1; $$);`
      )
    ).toEqual([]);

    // Unscheduling one is always allowed.
    expect(schedulesReachingRetired(`SELECT cron.unschedule('ca-fee-sweep-30m');`)).toEqual([]);
  });

  it('no migration after the baseline schedules one', () => {
    const names = migrationNames();
    expect(names, 'the baseline migration is still in the tree').toContain(SCHEDULING_BASELINE);

    const offenders: string[] = [];
    for (const name of names.filter((n) => n > SCHEDULING_BASELINE)) {
      for (const job of schedulesReachingRetired(readFileSync(join(MIGRATIONS, name), 'utf8'))) {
        offenders.push(`${name} schedules ${job}`);
      }
    }
    expect(
      offenders,
      'a migration is putting a retired fee repair back on a timer. The rake and BBJ drop ' +
        'of an accepted hand are banked by its own post-commit envelope; if something is ' +
        'unbanked, fix the writer (CLAUDE.md 10.12), do not schedule a sweep.'
    ).toEqual([]);
  });
});
