import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeChipTransaction,
  presentChipTransaction,
  thirdPartySender,
  walletRoute,
} from '../src/components/wallet/describeChipTransaction';

/**
 * A HORSE IS NEVER NAMED (Dan, 2026-09-14, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY."
 *
 * CLAUDE.md 10.5 made horses players in every respect but left one thing on
 * the client: `is_horse` could still be surfaced "as DATA (a badge, a
 * column, a roster field)". This ruling closes that. From today, no surface
 * in the web client - player-facing or operator-facing - may show, label,
 * filter by, export, or otherwise let a person infer which players are
 * horses. Removed on 2026-09-14: the "Hide Horses" toggle and its
 * "(Horses Hidden)" / "People Only" relabelling on the club dashboard and
 * the club data page, the "H" / "Horse" badges on both leaderboards, the
 * "(Horse)" role suffix in the cashier trade roster and the blacklist
 * member picker, and the `is_horse` CSV columns on every export those pages
 * offered. See docs/changelog/2026-09-14-a-horse-is-never-named.md.
 *
 * WHAT THIS DOES NOT REACH, ON PURPOSE
 *
 * `is_horse` / `isHorse` stay legitimate as plumbing:
 *   - a type member (`is_horse: boolean;`) describing what an RPC returns,
 *     never painted;
 *   - a plain (non-JSX) object-literal mapping, e.g. `isHorse: !!p.is_horse,`
 *     building a row that nothing downstream renders or filters on;
 *   - a Supabase `.select(...)` / `.eq(...)` / `.rpc(...)` / `.from(...)`
 *     call reading or writing the column server-side;
 *   - a comment.
 * This law does not walk the type graph to prove a kept field truly never
 * reaches a screen - that judgement call is made once, by a person, at the
 * point of removal (see the changelog). What it CAN check by grep, on every
 * commit, forever, is the shape a reveal actually takes: a literal phrase a
 * player or operator would read, or the flag driving a JSX condition or
 * attribute or sitting in a CSV header row. Every reveal found on
 * 2026-09-14 took one of exactly those shapes.
 *
 * WHAT IS BANNED, PRECISELY
 *
 *   1. The literal phrases 'Hide Horses', 'Horses Hidden', 'People Only',
 *      'title="Horse"', '(Horse)' - copy a person would read.
 *   2. The identifier `hideHorses` anywhere - it never had a legitimate use
 *      other than the retired toggle, so its reappearance IS the regression.
 *   3. `is_horse` or `isHorse` quoted as a bare array element (a CSV header
 *      cell), e.g. `'is_horse',` - never `is_horse: value` (a key) or a
 *      multi-field select string.
 *   4. `is_horse` or `isHorse` reached via a dot (`.is_horse`, `.isHorse`)
 *      inside a same-line `{...}` - a JSX condition, ternary or attribute
 *      value. A same-line inline TYPE literal (`{ is_horse?: boolean }`)
 *      never matches this: nothing there is reached via a dot.
 */

const ROOTS = ['src/pages', 'src/components'];
const ROOT = join(__dirname, '..');

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFilesUnder(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((root) => tsxFilesUnder(join(ROOT, root)));

/** Service-call plumbing: a line reading or writing the column server-side. */
const SERVICE_CALL = /\.(select|eq|rpc|from)\(/;

/** A bare quoted `'is_horse'` / `"isHorse"` token - never `key: value`. */
const CSV_HEADER_TOKEN = /(['"])(?:is_horse|isHorse)\1(?!\s*:)/;

/** `.is_horse` / `.isHorse` reached inside a same-line `{...}` span. */
const JSX_BRACE_SPAN = /\{[^{}\n]*\.(?:is_horse|isHorse)\b/;

interface Hit {
  file: string;
  line: number;
  text: string;
  rule: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, idx) => {
      const line = idx + 1;
      const t = raw.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // comments never run

      if (raw.includes('Hide Horses'))
        hits.push({ file: rel, line, text: t, rule: "'Hide Horses'" });
      if (raw.includes('Horses Hidden'))
        hits.push({ file: rel, line, text: t, rule: "'Horses Hidden'" });
      if (raw.includes('People Only'))
        hits.push({ file: rel, line, text: t, rule: "'People Only'" });
      if (raw.includes('title="Horse"'))
        hits.push({ file: rel, line, text: t, rule: 'title="Horse"' });
      if (raw.includes('(Horse)')) hits.push({ file: rel, line, text: t, rule: "'(Horse)'" });
      if (/\bhideHorses\b/.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'identifier hideHorses' });

      if (SERVICE_CALL.test(raw)) return; // a query string naming the column is plumbing

      if (CSV_HEADER_TOKEN.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'is_horse/isHorse as a CSV header cell' });
      if (JSX_BRACE_SPAN.test(raw))
        hits.push({ file: rel, line, text: t, rule: 'is_horse/isHorse driving a JSX expression' });
    });
  }
  return hits;
}

describe('a horse is never named (Dan 2026-09-14, binding)', () => {
  it('scanned at least src/pages and src/components, so an empty result means something', () => {
    // A walker that silently found zero files would make every assertion
    // below vacuously true. Both roots exist and hold plenty of .tsx.
    expect(FILES.length).toBeGreaterThan(50);
  });

  const hits = scan();
  const byRule = new Map<string, Hit[]>();
  for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);

  const RULES = [
    "'Hide Horses'",
    "'Horses Hidden'",
    "'People Only'",
    'title="Horse"',
    "'(Horse)'",
    'identifier hideHorses',
    'is_horse/isHorse as a CSV header cell',
    'is_horse/isHorse driving a JSX expression',
  ];

  it.each(RULES)('no file under src/pages or src/components reveals a horse via: %s', (rule) => {
    const found = byRule.get(rule) ?? [];
    expect(
      found.map((h) => `${h.file}:${h.line}: ${h.text}`),
      found.length > 0
        ? `Dan, 2026-09-14 (binding): "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY."`
        : undefined
    ).toEqual([]);
  });
});

/**
 * THE TRADE RECORD CANNOT PRINT A HORSE LABEL (cashier launch round 3,
 * contract 2, 2026-10-09; Dan: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY"
 * and "HORSES ARE NEVER EVER EXCLUDED BY DESIGN").
 *
 * The treasury writers book a horse's seat funding, rebuy shortfall and
 * bankroll top-up under a kind of their own - from nobody, to the horse, no
 * metadata, a stock note naming a horse - and the Trade record printed that
 * kind as the row's label ("Horse Treasury Funding"), matched a search on it
 * and copied it into receipts: one search listed every horse in the club. The
 * record builds every row from presentChipTransaction, which presents the
 * legacy kind as the Club Bank send it is, and a third party reads every Club
 * Bank send by its pot, so a send nobody pressed reads like one somebody did.
 *
 * Pinned two ways: each writer's row, as the record presents it, is a human
 * Club Bank send's word for word (kind, label, route, sentence, sending side;
 * the amount and the recipient kept, the note gone); and the page builds
 * every row from that presentation, with no line of code of its own, and none
 * in the presentation module but the one legacy spelling it maps, naming a
 * horse. The rendered row is tested in tests/cashier-r3trade-launch.test.tsx.
 */
describe('the Trade record cannot print a horse label (round 3, contract 2)', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const ADMIN = '22222222-2222-4222-8222-222222222222';
  const SEATED = '33333333-3333-4333-8333-333333333333';
  const PERSON = '44444444-4444-4444-8444-444444444444';
  /** Two members with one alias, so the two sentences can be compared whole. */
  const names = new Map([
    [OWNER, 'Club Owner'],
    [ADMIN, 'Desk Admin'],
    [SEATED, 'Midnight Run'],
    [PERSON, 'Midnight Run'],
  ]);
  /** Each writer's note, from its INSERT in supabase/migrations. */
  const WRITER_NOTES = [
    'Horse buy-in/rebuy funded from club treasury',
    'Horse seated + funded from club treasury',
    'Horse rebuy shortfall funded from club treasury (wallet paid 25)',
    'Topped up to the club bankroll floor so the horse can buy into any table',
  ];
  const funded = (notes: string) => ({
    transaction_type: 'horse_treasury_funding',
    amount: 500,
    from_user_id: null,
    to_user_id: SEATED,
    notes,
    metadata: null,
  });
  /** The same movement for a person: staff paying a member's player wallet. */
  const human = {
    transaction_type: 'club_bank_send',
    amount: 500,
    from_user_id: ADMIN,
    to_user_id: PERSON,
    notes: 'Club Bank Send',
    metadata: { op_id: 'k', destination: 'player_wallet', actor_role: 'admin' },
  };
  const label = (kind: unknown) =>
    String(kind ?? '')
      .split('_')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  it.each(WRITER_NOTES)('presents the row noted %j as a human Club Bank send', (note) => {
    const shown = presentChipTransaction(funded(note));
    expect(label(shown.transaction_type)).toBe(label(human.transaction_type));
    expect(shown.notes).toBeNull();
    expect(shown.metadata).toEqual({ destination: 'player_wallet' });
    // Never dropped, never resized, still paid to the member it paid.
    expect(shown.amount).toBe(500);
    expect(shown.to_user_id).toBe(SEATED);
    for (const reader of [OWNER, null]) {
      expect(describeChipTransaction(funded(note), names, reader)).toBe(
        describeChipTransaction(human, names, reader)
      );
    }
    expect(walletRoute(funded(note))).toBe(walletRoute(human));
    expect(thirdPartySender(shown, null)).toBe(thirdPartySender(human, 'Desk Admin'));
    const printed = [
      label(shown.transaction_type),
      shown.notes,
      JSON.stringify(shown.metadata),
      describeChipTransaction(funded(note), names, OWNER),
      walletRoute(funded(note)),
      thirdPartySender(shown, null),
    ].join(' | ');
    expect(printed).not.toMatch(/horse/i);
  });

  it('builds every Trade record row from that presentation, and no code names a horse', () => {
    const page = readFileSync(join(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');
    const load = page.slice(
      page.indexOf("supabase.rpc('fn_cashier_transaction_history'"),
      page.indexOf("reportError(e, 'CashierTradePage.records')")
    );
    expect(load.length).toBeGreaterThan(0);
    const presentation = 'const r = presentChipTransaction(raw);';
    const mapped = load.indexOf('pageRows.map((raw) => {');
    const presented = load.indexOf(presentation);
    expect(mapped).toBeGreaterThan(-1);
    expect(presented).toBeGreaterThan(mapped);
    // Nothing reads the ledger row as it arrived once it has been presented.
    expect(load.slice(presented + presentation.length)).not.toMatch(/\braw\b/);
    expect(load).toContain('${thirdPartySender(r, r.from_name)} To ');
    expect(load).not.toMatch(/\$\{r\.from_name \|\| 'A Member'\} To /);

    const code = (source: string) =>
      source
        .split('\n')
        .map((line) => line.trim())
        .filter((t) => t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'))
        .filter((t) => /horse/i.test(t));
    expect(code(page)).toEqual([]);
    expect(
      code(readFileSync(join(ROOT, 'src/components/wallet/describeChipTransaction.ts'), 'utf8'))
    ).toEqual(["const LEGACY_CLUB_BANK_SEND_KINDS = new Set<string>(['horse_treasury_funding']);"]);
    expect(code(readFileSync(join(ROOT, 'src/services/CashierResilience.ts'), 'utf8'))).toEqual([]);
  });
});

/**
 * NO HORSE ROW WEARS A LABEL OF ITS OWN (cashier launch B-5, 2026-10-11).
 *
 * The ledger label maps gave each horse-only kind its own words - "Treasury
 * Funding", "Table Funding", "Auto Refill" - plus, on the wallet history, its
 * own grey ink and refill mark. No human row ever printed those, so the label
 * alone told a reader which member was a horse. Each kind now reads as the
 * human movement it is. Pinned on the source of every map that names one: a
 * horse-only key may only carry a label some human key in the same file also
 * carries, and the retired words are gone.
 */
describe('no horse row wears a label of its own (B-5)', () => {
  const MAPS = [
    'src/components/wallet/PlayerWalletModal.tsx',
    'src/components/wallet/ChipStatement.tsx',
    'src/components/wallet/TransactionHistory.tsx',
    'src/pages/CashierStatementsPage.tsx',
    'src/pages/CashierPage.tsx',
  ];

  it.each(MAPS)('%s gives every horse key a human label', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const entries = [...source.matchAll(/^\s*([a-z_]+):\s*'([^']*)',?\s*$/gm)].map((m) => ({
      key: m[1],
      value: m[2],
    }));
    const human = new Set(entries.filter((e) => !/horse/.test(e.key)).map((e) => e.value));
    const horse = entries.filter((e) => /horse/.test(e.key));
    for (const entry of horse) expect(human.has(entry.value), `${file} ${entry.key}`).toBe(true);
    expect(source).not.toMatch(/'(?:Treasury Funding|Table Funding|Auto Refill)'/);
  });

  it('the wallet history prints a club refill exactly as a transfer', () => {
    const source = readFileSync(join(ROOT, 'src/components/wallet/TransactionHistory.tsx'), 'utf8');
    expect(source).toContain("return raw === 'horse_refill' ? 'transfer' : raw;");
    // All rows use the same text treatment; no category glyph can identify a player.
    expect(source).not.toContain('CATEGORY_ICONS');
    expect(source).toContain('CATEGORY_LABELS[shownCategory(raw)]');
    expect(source).toContain('CATEGORY_COLORS[shownCategory(tx.category)]');
  });
});
