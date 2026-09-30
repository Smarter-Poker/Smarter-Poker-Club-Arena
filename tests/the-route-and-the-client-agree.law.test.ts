/**
 * LAW: THE ROUTE AND THE CLIENT AGREE (phase 8 of 8, 2026-09-29).
 * ===========================================================================
 * Phases 1-7 built a chain of contracts between Postgres and the diamond
 * wallet, and every link of it was pinned on ONE side only. The SQL laws read
 * the migrations; the component tests mock the RPC with a hand-written
 * payload. Both stay green while the two halves drift apart, because neither
 * ever compares them.
 *
 * Every break this programme has already shipped is in that shape:
 *
 *   - a column dropped from a `select(...)` while the mapper still reads it
 *     (the whole ledger renders "Adjustment" because `type` was not asked
 *     for);
 *   - a renamed jsonb key (`on_hand` -> `onHand` in SQL) that a `Number(...)`
 *     turns into `NaN`, or a `|| 0` turns into a zero a player believes;
 *   - a bucket key the map can emit that nothing on screen accounts for, so
 *     diamonds leave a breakdown that still adds up to a smaller total.
 *
 * None of those is a crash. The only symptom is a blank or wrong figure on a
 * money surface, and the player is the detector. This law is the missing
 * comparison: it derives the ROUTE's shape from the SQL that production runs
 * (the latest migration declaring each function, chosen by version, never a
 * hard-coded filename) and the CLIENT's shape from the source that reads it,
 * and it fails when either side moves without the other.
 *
 * CLAUDE.md 10.86: a check must have three outcomes. Every derivation here
 * throws when it cannot find what it is looking for, rather than resolving to
 * an empty set that reads as agreement.
 *
 * WHAT IS PINNED
 *   1. Ledger reads. The exact column list of every `diamond_transactions`
 *      select, the columns the mapper beside it reads, and the two failures
 *      between them: read-but-not-selected (a blank field) and
 *      selected-but-never-read (dead weight on a money query).
 *   2. `player_line`. A PostgREST COMPUTED column, absent from every
 *      stored-column snapshot of the table, so only a law that knows it is a
 *      function can protect it. Its function, its purity and its grant are
 *      pinned here, and no migration may turn it into a stored column.
 *   3. RPC keys. For each of the four diamond RPCs, the key set the SQL
 *      builds against the key set the service destructures, in BOTH
 *      directions. A key the client reads that SQL no longer emits is red; a
 *      key SQL emits that nothing reads is red unless it is declared below
 *      with a reason.
 *   4. Buckets. Every bucket `fn_diamond_kind_bucket` can emit, against what
 *      the panel does with it: each bucket carries a player-facing label, and
 *      the panel enumerates NO bucket of its own, so a bucket added in SQL
 *      reaches the screen without a client change. An allowlist in the client
 *      is exactly how a bucket would go missing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const MIGRATIONS_DIR = 'supabase/migrations';

const MIGRATION_FILES = readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * The definition production runs is the LAST migration that declares it, by
 * version. Naming the file instead is how a law ends up pinning a definition
 * that three later migrations have already replaced.
 */
function latestDeclaring(decl: string): { file: string; body: string } {
  const hits = MIGRATION_FILES.filter((f) => read(`${MIGRATIONS_DIR}/${f}`).includes(decl));
  if (hits.length === 0) {
    throw new Error(`no migration in ${MIGRATIONS_DIR} declares: ${decl}`);
  }
  const file = hits[hits.length - 1];
  const sql = read(`${MIGRATIONS_DIR}/${file}`);
  return { file: `${MIGRATIONS_DIR}/${file}`, body: sql.slice(sql.indexOf(decl)) };
}

/**
 * The key literals a `jsonb_build_object(...)` writes: a quoted lower-snake
 * token in key position, which is the token immediately followed by a comma.
 * `auth.jwt() ->> 'role'` is a READ of a claim, not a key this function
 * emits, so it is removed before the scan.
 */
function sqlKeys(text: string): Set<string> {
  const scrubbed = text.replace(/->>\s*'[a-z_]+'/g, '');
  return new Set([...scrubbed.matchAll(/'([a-z][a-z_0-9]*)',/g)].map((m) => m[1]));
}

/** The body of one method of the DiamondService object literal. */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  if (start < 0) throw new Error(`DiamondService has no method ${name}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}async [A-Za-z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every `<identifier>.<key>` the given code reads.
 *
 * DELIBERATELY NOT NARROWED TO EXCLUDE THE MAPPER (considered 2026-09-30).
 * ---------------------------------------------------------------------------
 * The "selected but never read" rule below could not see the dead
 * `description` column on the two ledger surfaces, because the only place that
 * touched it was the mapper - `description: String(tx.description || '')` -
 * and this function matches `tx.description` wherever it appears. So the
 * obvious repair is to ignore a `<key>: ...<row>.<key>...` assignment and
 * count only readers further downstream.
 *
 * That is wrong here, and it fails LOUDLY on the first run: on these surfaces
 * EVERY selected column is touched exactly once, in the mapper, and nowhere
 * else in the file. `tx.id`, `tx.amount`, `tx.created_at`, `tx.metadata` all
 * look identical to `tx.description` under that narrowing, and all four are
 * genuinely printed - by a DIFFERENT file, off the mapped shape. Telling the
 * two apart means following the mapped row's type into its consumers
 * (PlayerWalletPage, DiamondFlowPanel, the modal's own JSX), which is a
 * different check from this one and not a regex.
 *
 * So the narrowing would turn a law with three honest outcomes into one that
 * fails on correct code, which is CLAUDE.md 10.86 in the other direction. The
 * mapper-assignment case is pinned where it can be stated exactly instead: the
 * phase-6 law names `description` on these three files and forbids both the
 * select and the assignment.
 */
function keysReadFrom(code: string, identifier: string): string[] {
  return [
    ...new Set(
      [...code.matchAll(new RegExp(`\\b${identifier}\\.([a-z][a-z_0-9]*)\\b`, 'g'))].map(
        (m) => m[1]
      )
    ),
  ].sort();
}

const sorted = (s: Iterable<string>) => [...s].sort();

// ===========================================================================
// 1 + 2. THE LEDGER READS
// ===========================================================================

/**
 * `public.diamond_transactions`, read from production on 2026-09-29:
 * thirteen stored columns, plus `player_line`, which is NOT one of them -
 * it is the PostgREST computed column below. A snapshot of the table's
 * columns cannot see it, which is why it is listed here by hand and pinned
 * as a function in its own test.
 */
const DIAMOND_TRANSACTION_FIELDS = new Set([
  'amount',
  'balance_after',
  'counterparty',
  'created_at',
  'description',
  'id',
  'issuance_class',
  'metadata',
  'reference_id',
  'source',
  'transaction_type',
  'type',
  'user_id',
  'player_line',
]);

interface LedgerRead {
  /** The identifier the mapper beside the query gives one returned row. */
  row: string;
  /** The select list, in the order the source writes it. */
  select: string[];
}

const LEDGER_READS: Record<string, LedgerRead> = {
  /* `description` left both of these on 2026-09-30. It was this law's own
     "selected but never read" rule that it broke, and this law could not see
     it - see the note under `keysReadFrom` below. The absence is pinned here
     and, as a mapper assignment, in the phase-6 law. */
  'src/hooks/useDiamondLedger.ts': {
    row: 'tx',
    select: ['id', 'type', 'transaction_type', 'amount', 'player_line', 'created_at', 'metadata'],
  },
  'src/components/wallet/DiamondWalletModal.tsx': {
    row: 't',
    select: [
      'id',
      'type',
      'transaction_type',
      'amount',
      'player_line',
      'balance_after',
      'created_at',
    ],
  },
  'src/pages/VIPPage.tsx': {
    row: 'entry',
    select: [
      'id',
      'type',
      'transaction_type',
      'amount',
      'player_line',
      'balance_after',
      'created_at',
    ],
  },
};

/** The columns each surface asks PostgREST for, read out of the source. */
function selectListFor(src: string, file: string): string[] {
  const at = src.indexOf(`.from('diamond_transactions')`);
  if (at < 0) throw new Error(`${file} no longer reads diamond_transactions`);
  const m = src.slice(at).match(/\.select\(\s*'([^']*)'/);
  if (!m) throw new Error(`${file} reads diamond_transactions with no literal select list`);
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

describe('the route and the client agree: the diamond ledger read', () => {
  it.each(Object.keys(LEDGER_READS))('%s asks for exactly the pinned columns', (file) => {
    expect(selectListFor(read(file), file)).toEqual(LEDGER_READS[file].select);
  });

  it.each(Object.keys(LEDGER_READS))(
    '%s reads no ledger column it did not select (the blank-field bug)',
    (file) => {
      const { row, select } = LEDGER_READS[file];
      const readKeys = keysReadFrom(read(file), row).filter((k) =>
        DIAMOND_TRANSACTION_FIELDS.has(k)
      );
      const notSelected = readKeys.filter((k) => !select.includes(k));
      expect(
        notSelected,
        `${file} reads ${notSelected.join(', ')} off a row it never asked PostgREST for. ` +
          `The field arrives undefined and the surface prints a blank, a zero or an ` +
          `"Adjustment" - add the column to the select in this same commit.`
      ).toEqual([]);
    }
  );

  it.each(Object.keys(LEDGER_READS))(
    '%s selects no ledger column it never reads (dead weight on a money query)',
    (file) => {
      const { row, select } = LEDGER_READS[file];
      const readKeys = new Set(keysReadFrom(read(file), row));
      const unread = select.filter((c) => !readKeys.has(c));
      expect(
        unread,
        `${file} asks PostgREST for ${unread.join(', ')} and never reads it. Either the ` +
          `surface stopped printing it (drop it from the select) or the read was lost ` +
          `(restore it) - an unread column on a ledger query is one half of a change.`
      ).toEqual([]);
    }
  );

  it('player_line is a computed column, not a stored one, and every reader may execute it', () => {
    // Every ledger surface asks for it.
    for (const [file, { select }] of Object.entries(LEDGER_READS)) {
      expect(select, `${file} must print the ledger's own player line`).toContain('player_line');
    }

    const fn = latestDeclaring('CREATE OR REPLACE FUNCTION public.player_line(');
    // It takes the ROW, which is what makes PostgREST serve it as a column.
    expect(fn.body).toMatch(
      /CREATE OR REPLACE FUNCTION public\.player_line\(\s*t\s+public\.diamond_transactions\s*\)/
    );
    expect(fn.body).toMatch(/RETURNS text/);
    // Pure, or PostgREST may not expose it as a column at all.
    expect(fn.body).toMatch(/IMMUTABLE/);
    // It is the one place the player-facing line is decided (phase 6).
    expect(fn.body).toContain('public.fn_diamond_ledger_line(');
    // Without this grant every ledger read is a 403, on every surface at once.
    expect(fn.body).toContain(
      'GRANT EXECUTE ON FUNCTION public.player_line(public.diamond_transactions) TO authenticated'
    );

    // And nothing may quietly turn it into a stored column: two definitions of
    // the same name is a column that shadows the function and never updates.
    const stored = MIGRATION_FILES.filter((f) =>
      /ALTER TABLE[^;]*diamond_transactions[^;]*ADD COLUMN[^;]*\bplayer_line\b/i.test(
        read(`${MIGRATIONS_DIR}/${f}`)
      )
    );
    expect(stored, 'player_line is computed; no migration may store it').toEqual([]);
  });
});

// ===========================================================================
// 3. THE RPC KEYS
// ===========================================================================

interface RpcContract {
  /** The name the client passes to supabase.rpc(). */
  rpc: string;
  /** How the SQL declares it, used to find the migration production runs. */
  decl: string;
  /** Where in that function the key literals start; the whole body if absent. */
  keysFrom?: string;
  /** The DiamondService method that calls it. */
  method: string;
  /** The exact call the client makes, so a renamed argument is red too. */
  call: string;
  /** Each identifier the method destructures, and every key it reads off it. */
  readers: Record<string, string[]>;
  /** Keys the SQL emits that the client deliberately never reads, and why. */
  unread: Record<string, string>;
}

/**
 * All three diamond RPCs date their own answer with `read_at`, and until
 * 2026-09-30 DiamondService parsed all three into a `readAt` field on the
 * returned shape. No surface in src/ ever rendered any of them, while
 * useDiamondWalletSummary's comment described its result as "the truth as
 * of readAt" - a staleness promise nothing kept. The parse was removed
 * rather than a fourth unrendered figure left sitting on a money shape,
 * where the next reader would reasonably assume it had always been shown.
 * The SQL still emits it and costs nothing to emit, so if a pane should
 * date its figures later (ChipStatement prints "Generated ..." and is the
 * precedent), restore the one parse line together with the surface that
 * renders it, and move this key back into `readers` in the same commit.
 */
const READ_AT_UNREAD =
  'the RPC dates its own answer; no diamond surface prints that timestamp today, ' +
  'so it is fetched and deliberately dropped rather than parsed and forgotten';

const RPC_CONTRACTS: RpcContract[] = [
  {
    rpc: 'fn_diamond_wallet_summary',
    decl: 'CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(',
    keysFrom: 'RETURN jsonb_build_object(',
    method: 'getWalletSummary',
    call: "supabase.rpc('fn_diamond_wallet_summary')",
    readers: {
      row: [
        'arena',
        'arena_entries',
        'arena_seats',
        'collateral',
        'in_arena',
        'lifetime_earned',
        'lifetime_spent',
        'on_hand',
        'sendable',
      ],
      arenaRaw: [
        'cash_games_enabled',
        'cheapest_table',
        'club_id',
        'min_cash_buy_in',
        'name',
        'open_cash_tables',
        'slug',
        'tournaments_enabled',
      ],
      t: ['big_blind', 'id', 'name', 'small_blind'],
    },
    unread: {
      user_id: 'the caller is the only user this function will answer for',
      read_at: READ_AT_UNREAD,
    },
  },
  {
    rpc: 'fn_diamond_flow_by_kind',
    decl: 'CREATE OR REPLACE FUNCTION public.fn_diamond_flow_by_kind(',
    keysFrom: 'SELECT jsonb_build_object(',
    method: 'getDiamondFlow',
    call: "supabase.rpc('fn_diamond_flow_by_kind')",
    readers: {
      row: ['earned', 'earned_last30', 'earned_total', 'spent', 'spent_last30', 'spent_total'],
      r: ['bucket', 'label', 'last30', 'last30_count', 'lifetime', 'lifetime_count'],
    },
    unread: {
      user_id: 'the caller is the only user this function will answer for',
      read_at: READ_AT_UNREAD,
    },
  },
  {
    rpc: 'fn_diamond_arena_reconciliation',
    decl: 'CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation(',
    method: 'getArenaStatement',
    call: "supabase.rpc('fn_diamond_arena_reconciliation')",
    readers: {
      row: [
        'balanced',
        'buy_ins',
        'cash_outs',
        'in_play',
        'net_result_settled',
        'open_sessions',
        'sessions',
        'unmatched',
      ],
      r: ['custody_id', 'reason', 'request_id'],
    },
    unread: {
      user_id: 'the caller is the only user this function will answer for',
      read_at: READ_AT_UNREAD,
    },
  },
  {
    rpc: 'fn_diamond_lifetime_totals',
    decl: 'CREATE OR REPLACE FUNCTION public.fn_diamond_lifetime_totals(',
    method: 'getLifetimeStats',
    call: "supabase.rpc('fn_diamond_lifetime_totals', {",
    readers: { row: ['lifetime_earned', 'lifetime_spent'] },
    unread: {
      credits: 'the row counts behind the two totals; the wallet prints the totals only',
      debits: 'the row counts behind the two totals; the wallet prints the totals only',
    },
  },
];

/**
 * `fn_diamond_lifetime_totals` is the one RETURNS TABLE of the four; its keys
 * are its output columns, not jsonb literals.
 */
function producedKeys(contract: RpcContract): Set<string> {
  const { body, file } = latestDeclaring(contract.decl);
  if (contract.rpc === 'fn_diamond_lifetime_totals') {
    const m = body.match(/RETURNS TABLE\s*\(([^)]*)\)/);
    if (!m) throw new Error(`${file} declares ${contract.rpc} with no RETURNS TABLE`);
    return new Set(
      m[1]
        .split(',')
        .map((c) => c.trim().split(/\s+/)[0])
        .filter(Boolean)
    );
  }
  const scope = contract.keysFrom ? body.slice(body.indexOf(contract.keysFrom)) : body;
  if (contract.keysFrom && !body.includes(contract.keysFrom)) {
    throw new Error(`${file} no longer builds ${contract.rpc}'s answer with ${contract.keysFrom}`);
  }
  const keys = sqlKeys(scope);
  if (keys.size === 0) throw new Error(`${file} yielded no keys for ${contract.rpc}`);
  return keys;
}

describe('the route and the client agree: the diamond RPCs', () => {
  const service = read('src/services/DiamondService.ts');

  it.each(RPC_CONTRACTS.map((c) => [c.rpc, c] as const))(
    '%s is called by name, and takes an argument the SQL still declares',
    (_rpc, contract) => {
      expect(service, `DiamondService must call ${contract.rpc}`).toContain(contract.call);
      const { body } = latestDeclaring(contract.decl);
      // Own-user by default: every one of these may be called with no argument.
      expect(body).toMatch(/p_user_id\s+uuid\s+DEFAULT/);
      if (contract.call.endsWith('{')) {
        expect(methodBody(service, contract.method)).toContain('p_user_id:');
      }
    }
  );

  it.each(RPC_CONTRACTS.map((c) => [c.rpc, c] as const))(
    '%s: the client destructures exactly the pinned keys',
    (_rpc, contract) => {
      const body = methodBody(service, contract.method);
      for (const [identifier, keys] of Object.entries(contract.readers)) {
        expect(keysReadFrom(body, identifier), `${contract.method} -> ${identifier}`).toEqual(
          [...keys].sort()
        );
      }
    }
  );

  it.each(RPC_CONTRACTS.map((c) => [c.rpc, c] as const))(
    '%s: every key the client reads is a key the SQL emits',
    (_rpc, contract) => {
      const produced = producedKeys(contract);
      const body = methodBody(service, contract.method);
      const consumed = new Set(
        Object.keys(contract.readers).flatMap((id) => keysReadFrom(body, id))
      );
      const invented = sorted(consumed).filter((k) => !produced.has(k));
      expect(
        invented,
        `${contract.method} reads ${invented.join(', ')} from ${contract.rpc}, which the ` +
          `SQL does not emit under that name. Number(undefined) is NaN and ` +
          `(undefined || 0) is a zero a player will believe - rename on both sides in ` +
          `one commit.`
      ).toEqual([]);
    }
  );

  it.each(RPC_CONTRACTS.map((c) => [c.rpc, c] as const))(
    '%s: every key the SQL emits is read, or declared unread with a reason',
    (_rpc, contract) => {
      const produced = producedKeys(contract);
      const body = methodBody(service, contract.method);
      const consumed = new Set(
        Object.keys(contract.readers).flatMap((id) => keysReadFrom(body, id))
      );
      const unread = sorted(produced).filter((k) => !consumed.has(k));
      expect(
        unread,
        `${contract.rpc} emits ${unread.join(', ')} and ${contract.method} reads none of ` +
          `it. A new figure nobody prints is half a feature; a renamed one is a blank ` +
          `on the wallet. Read it, or declare it in this contract's \`unread\` with a reason.`
      ).toEqual(sorted(Object.keys(contract.unread)));
      for (const [key, why] of Object.entries(contract.unread)) {
        expect(why.length, `${contract.rpc}.${key} needs a reason, not a blank`).toBeGreaterThan(
          15
        );
      }
    }
  );
});

// ===========================================================================
// 4. THE BUCKETS
// ===========================================================================

/**
 * Every bucket `fn_diamond_kind_bucket` can put a ledger row in, read from
 * the migration production runs and confirmed against the live function on
 * 2026-09-29. Ten sinks, eleven sources, `transfers` on both sides.
 */
const BUCKETS = [
  'adjustments',
  'arena',
  'arena_cash_outs',
  'bonuses',
  'club_chips',
  'games',
  'gifts_received',
  'gifts_sent',
  'grants',
  'other_earned',
  'other_spent',
  'purchase_refunds',
  'purchases',
  'refunds',
  'rewards',
  'social',
  'store',
  'transfers',
  'vip',
  'vip_bonuses',
  'winnings',
];

/** The two catch-alls share one label, so they are the one pair without their own arm. */
const CATCH_ALLS = ['other_earned', 'other_spent'];

describe('the route and the client agree: the flow buckets', () => {
  const map = latestDeclaring('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(');

  const emitted = sorted(
    new Set([
      ...[...map.body.matchAll(/THEN '([a-z][a-z_0-9]*)'/g)].map((m) => m[1]),
      ...[...map.body.matchAll(/ELSE '([a-z][a-z_0-9]*)'/g)].map((m) => m[1]),
    ])
  );

  it('the map emits exactly the buckets this law knows about', () => {
    expect(
      emitted,
      `fn_diamond_kind_bucket in ${map.file} emits a different set of buckets than this ` +
        `law pins. A new bucket must be added to BUCKETS here in the same commit, so the ` +
        `label and panel checks below are asked about it.`
    ).toEqual(BUCKETS);
  });

  it('every bucket carries a player-facing label, so no breakdown line is unnamed', () => {
    const labelled = new Set(
      [...map.body.matchAll(/WHEN '([a-z][a-z_0-9]*)'\s+THEN '([A-Z][^']*)'/g)].map((m) => m[1])
    );
    const unlabelled = BUCKETS.filter((b) => !labelled.has(b) && !CATCH_ALLS.includes(b));
    expect(unlabelled, 'these buckets would print with no name on the wallet').toEqual([]);
    // The catch-alls are deliberate, and they do carry a name.
    expect(map.body).toMatch(/ELSE 'Other'/);
  });

  it('the panel enumerates no bucket of its own: a bucket added in SQL reaches the screen', () => {
    /* The bucket that goes missing is never the one someone remembered to add
       to a list. So there is no list: the panel prints the label the SQL sent
       with the line, and the maths filters on the amount, not on the name. */
    const panel = read('src/components/wallet/DiamondFlowPanel.tsx');
    const maths = read('src/components/wallet/diamondFlowMath.ts');
    const service = methodBody(read('src/services/DiamondService.ts'), 'getDiamondFlow');

    for (const [name, src] of Object.entries({
      'DiamondFlowPanel.tsx': panel,
      'diamondFlowMath.ts': maths,
      'DiamondService.getDiamondFlow': service,
    })) {
      const quoted = new Set([...src.matchAll(/'([a-z][a-z_0-9]*)'/g)].map((m) => m[1]));
      const named = BUCKETS.filter((b) => quoted.has(b));
      expect(
        named,
        `${name} names the buckets ${named.join(', ')}. A bucket allowlist in the client ` +
          `is how a bucket added in SQL stops reaching the screen - render what the RPC ` +
          `sends, and keep the naming in fn_diamond_kind_bucket.`
      ).toEqual([]);
    }

    // What it renders instead: the line's own label, for every line it is given.
    expect(panel).toContain('{line.label}');
    expect(panel).toContain('const shown = linesFor(lines, span);');
    expect(panel).toContain('shown.map((line) =>');
    // The only filter is "did this bucket carry diamonds in the chosen window".
    expect(maths).toContain('.filter((l) => amountIn(l, span) > 0)');
    expect(maths).not.toMatch(/\bbucket\s*===/);
    expect(panel).not.toMatch(/\bbucket\s*===/);
  });
});
