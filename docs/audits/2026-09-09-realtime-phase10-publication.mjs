import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const root = process.cwd();
const base = 'https://smarter.poker/hub/club-arena/';
const testedHead = '052c00ff412082340e33c7716ebff5bc352718e0';
const fetchText = async (url) => {
  const u = new URL(url);
  u.searchParams.set('verify', Date.now().toString());
  const response = await fetch(u, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, url);
  return response.text();
};
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const parse = (text) =>
  ts.createSourceFile('bundle.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function findAll(node, predicate) {
  const out = [];
  function visit(n) {
    if (predicate(n)) out.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return out;
}
function one(nodes, label) {
  assert.equal(nodes.length, 1, label);
  return nodes[0];
}
function select(text, kind) {
  const source = parse(text);
  const marker =
    kind === 'history-owner'
      ? 'cashier_tx_cache_v2_'
      : 'Transaction history response is incomplete';
  return one(
    findAll(source, (n) => ts.isFunctionDeclaration(n) && n.getText(source).includes(marker)),
    kind
  );
}
function normalized(node) {
  const start = node.getStart();
  let text = node.getText();
  const identifiers = findAll(
    node,
    (n) =>
      ts.isIdentifier(n) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
      !(ts.isBindingElement(n.parent) && n.parent.propertyName === n)
  );
  const names = new Map();
  for (const n of identifiers) if (!names.has(n.text)) names.set(n.text, 'identifier' + names.size);
  for (const n of identifiers.sort((a, b) => b.getStart() - a.getStart()))
    text = text.slice(0, n.getStart() - start) + names.get(n.text) + text.slice(n.end - start);
  return text;
}
const assetsPath = path.join(root, 'dist/assets');
const builtName = one(
  fs.readdirSync(assetsPath).filter((n) => /^CashierPage-.*\.js$/.test(n)),
  'local Cashier asset'
);
const built = fs.readFileSync(path.join(assetsPath, builtName), 'utf8');
// Select both whole functions before querying production, so a bad verifier is local.
for (const kind of ['history-owner', 'cashier-page']) select(built, kind);
if (process.argv.includes('--local')) {
  console.log('Local whole-function selectors verified');
  process.exit(0);
}
const checkedAt = new Date().toISOString();
const stamps = await Promise.all(
  [base + 'build-info.json', 'https://ca-static.smarter.poker/build-info.json'].map(async (url) => {
    const j = JSON.parse(await fetchText(url));
    return { url, ca_sha: j.ca_sha, built_at: j.built_at, run_id: j.run_id };
  })
);
assert.equal(stamps[0].ca_sha, stamps[1].ca_sha, 'public and origin releases agree');
const html = await fetchText(base);
const tag = one(
  [...html.matchAll(/<script\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((s) => s.includes('type="module"') && /src=/.test(s)),
  'entry script'
);
const entryUrl = new URL(tag.match(/src="([^"]+)"/)[1], base).href;
const entry = await fetchText(entryUrl);
const source = parse(entry);
const names = [
  ...new Set(
    findAll(
      source,
      (n) => ts.isStringLiteral(n) && n.text.includes('CashierPage-') && n.text.endsWith('.js')
    ).map((n) => path.basename(n.text))
  ),
];
const cashierUrl = new URL(one(names, 'referenced Cashier asset'), entryUrl).href;
const cashier = await fetchText(cashierUrl);
console.log(JSON.stringify({ checked_at: checkedAt, stamps, entryUrl, cashierUrl }));
assert.ok(
  cashier.includes('Transaction History Could Not Be Refreshed. Please Try Again.'),
  'served history failure message'
);
assert.ok(cashier.includes('Retry History'), 'served retry action');
const comparisons = ['history-owner', 'cashier-page'].map((kind) => ({
  kind,
  matchesTestedBuild: normalized(select(cashier, kind)) === normalized(select(built, kind)),
}));
const runtimePaths = ['src/hooks/useCashierHistory.ts', 'src/pages/CashierPage.tsx'];
const sameRuntime = runtimePaths.map((file) => ({
  file,
  matchesTestedHead: execFileSync('git', ['show', testedHead + ':' + file], { cwd: root }).equals(
    execFileSync('git', ['show', stamps[0].ca_sha + ':' + file], { cwd: root })
  ),
}));
const report = {
  checked_at: checkedAt,
  tested_head: testedHead,
  stamps,
  method:
    'Whole Cashier page and history hook ASTs, with consistent identifier renaming. Property names, values and identifier relationships retained.',
  assets: [
    { url: entryUrl, sha256: sha(entry) },
    { url: cashierUrl, sha256: sha(cashier) },
  ],
  comparisons,
  runtimeFiles: sameRuntime,
  acceptance:
    'Public release bytes verified against the tested build. Physical iPad/PWA and authenticated live-player acceptance remain unverified.',
};
fs.writeFileSync('/tmp/realtime-phase10-publication.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.ok(
  comparisons.every((c) => c.matchesTestedBuild),
  'served whole functions match tested build'
);
assert.ok(
  sameRuntime.every((c) => c.matchesTestedHead),
  'released source matches tested source'
);
