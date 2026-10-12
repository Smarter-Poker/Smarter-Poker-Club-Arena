import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const catalog = JSON.parse(read('docs/lightning/release-gates.json'));
const rollout = read('docs/lightning/ROLLOUT.md');
const review = read('docs/lightning/FINAL-RELEASE-REVIEW.md');
const stage1 = rollout.split('## Stage 1:')[1].split('## Stage 2:')[0];
const stage2 = rollout.split('## Stage 2:')[1].split('## Stage 3:')[0];

describe('the original Lightning final gate survives the release review', () => {
  it('retains all 54 exact requirements in their original order', () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.programmePhase).toBe(14);
    expect(catalog.specificationPhases).toEqual([23, 24]);
    expect(catalog.requirements.map((g: { id: string }) => g.id)).toEqual(
      Array.from({ length: 54 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    );
    const titles = catalog.requirements.map((g: { requirement: string }) => g.requirement);
    expect(createHash('sha256').update(titles.join('\n')).digest('hex')).toBe(
      'd7b3c1586aa87c44d41685d47f41d03ddb1e812e370777d5d79f94098c3c8205'
    );
  });

  it('maps every requirement to existing maintained qualification, without file existence claiming a pass', () => {
    expect(catalog.purpose).toContain('File existence is not execution evidence');
    const documented = new Map(
      review
        .split('\n')
        .filter((line) => /^\|\s*L\d{2}\s*\|/.test(line))
        .map((line) => {
          const cells = line.split('|').map((cell) => cell.trim());
          return [cells[1], cells[2]];
        })
    );
    expect(documented.size).toBe(54);
    for (const gate of catalog.requirements) {
      expect(gate.qualificationFiles.length, gate.id).toBeGreaterThan(0);
      for (const path of gate.qualificationFiles)
        expect(existsSync(resolve(root, path)), path).toBe(true);
      expect(documented.get(gate.id), gate.id).toBe(gate.requirement);
    }
    expect(review).toContain('Current public-launch verdict: NO_GO');
    expect(review).toContain('not silently promoted from a source assertion');
  });
});

describe('a shadow-only stage cannot manufacture hand evidence', () => {
  it('matches the actual no-hands worker and empty-ledger behavior', () => {
    const sql = read(
      'supabase/migrations/20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql'
    );
    const ledger = read('server/src/lightning/LightningLatencyLedger.ts');
    expect(sql).toContain('worker_mode shadow plans and compares and forms no hands');
    expect(sql).toContain("'NO_LATENCY_EVIDENCE', 'severity', 'evidence'");
    expect(ledger).toContain('if (Object.keys(legs).length === 0) return;');
    expect(stage1).toContain('NO_LATENCY_EVIDENCE');
    expect(stage1).toContain('zero samples are missing evidence, never a passing p95');
    expect(stage1).not.toContain("Latency windows recorded for the Cluster with every leg's p95");
  });

  it('requires a viable comparison window within the unchanged stage budget', () => {
    expect(stage1).toContain('at most 60 minutes');
    expect(stage1).toContain('at least 30 nonempty comparisons');
    expect(stage1).toContain('300000ms windows cannot');
    expect(stage1).toContain('never extend the time box or fabricate comparisons');
    expect(stage1).toContain('verdict `calibrated`');
  });

  it('requires active-play evidence without reinstating the owner-removed calendar waits', () => {
    expect(stage2).toContain('every configured leg with nonzero samples');
    expect(stage2).toContain('absent leg is missing evidence');
    expect(stage2).toContain('At least 5,000 actual completed Lightning hands');
    expect(rollout).toContain('across at least five clubs and both table sizes');
    for (const text of [
      stage2,
      rollout.split('## Stage 3:')[1].split('## The Pilot Cluster')[0],
      review.split('## Outstanding Production Evidence')[1],
    ]) {
      expect(text).not.toMatch(
        /(?:at least|requires|has run)\s+(?:7 days|14 days|72 hours|seven actual days|fourteen actual days)/i
      );
    }
    expect(rollout).toContain('No minimum elapsed-day or batch-age requirement applies');
    expect(review).toContain('No minimum elapsed-day or batch-age requirement applies');
    expect(rollout).toContain('not time spent with an empty pool');
    expect(rollout).toContain('There is no minimum batch-age wait');
    expect(review).toContain('REMAINING-WORK.md');
    expect(review).toContain(
      'No synthetic hands, backdated timestamps or manufactured ledger rows'
    );
  });

  it('gives a real read-only proof route and preserves the separate readiness proof boundary', () => {
    expect(rollout).not.toContain('bin/proofs.sh');
    expect(rollout).toContain('configured read-only database tool');
    expect(rollout).toContain('proofs_evaluated_in_sql');
    expect(rollout).toContain('Separate exact installed-migration proof readback is required');
    expect(rollout).toContain('An unavailable, cancelled, skipped or stale result is not PASS');
  });
});

// Comments and implementation notes may discuss a competitor. Player-facing
// string literals, templates and RPC/error text must keep our own terminology.
it('keeps competitor product names out of Lightning strings that can reach a player', () => {
  const prohibited =
    /\b(?:PokerStars|GGPoker|PokerBros|Zoom|Rush(?:\s*&\s*Cash|\s+Poker)?|Snap\s+Poker|FastForward|Blitz\s+Poker)\b/i;
  const paths: string[] = [];
  function collect(directory: string): void {
    for (const item of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory() && item.name !== '__tests__') collect(path);
      else if (item.isFile() && /\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name))
        paths.push(path);
    }
  }
  for (const directory of [
    'src/lightning',
    'src/components/lightning',
    'src/pages/club/lightning',
    'server/src/lightning',
  ])
    collect(directory);
  paths.push('src/pages/LightningEntryPage.tsx', 'src/pages/club/ClubLightningOperationsPage.tsx');
  expect(paths.length).toBeGreaterThan(40);
  for (const path of paths) {
    const source = ts.createSourceFile(
      path,
      read(path),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    function visit(node: ts.Node): void {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isJsxText(node)
      )
        expect(node.text, `${path}: ${node.getStart(source)}`).not.toMatch(prohibited);
      if (ts.isTemplateExpression(node)) {
        for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)])
          expect(part.text, `${path}: ${part.getStart(source)}`).not.toMatch(prohibited);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
