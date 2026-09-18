// Execute the actual maintained decoder on receipts emitted by PostgreSQL.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, output, mode] = process.argv.slice(2);
// The accounting job installs server/package-lock.json, not the client dependencies.
const ts = createRequire(path.join(root, 'server/package.json'))('typescript');
if (mode && mode !== '--original-five-custody-only') throw new Error('Unknown native receipt qualification mode');
const compiled = path.join(output, 'actual-decoder');
fs.mkdirSync(compiled, { recursive: true });
for (const [source, destination] of [
  ['server/src/lib/uuidShape.ts', 'uuidShape.mjs'],
  ['server/src/tournament/completionSettlementReceipt.ts', 'completionSettlementReceipt.mjs'],
]) {
  const text = fs.readFileSync(path.join(root, source), 'utf8');
  const result = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: source,
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Actual decoder compilation failed: ${source}`);
  }
  fs.writeFileSync(path.join(compiled, destination), result.outputText.replace('../lib/uuidShape.js', './uuidShape.mjs'));
}
const { verifyTournamentCompletionReceipt } = await import(pathToFileURL(path.join(compiled, 'completionSettlementReceipt.mjs')));
let verified = 0;
const runs = [
  ['legacy-finality-custody-qualification.log', 'LEGACY_FEE_NATIVE_RECEIPTS=', 'fee_custody_unresolved'],
  ['legacy-original-resolution-qualification.log', 'LEGACY_FEE_NATIVE_RESOLVED=', 'recognized'],
];
for (const [file, marker, state] of mode ? runs.slice(0, 1) : runs) {
  const text = fs.readFileSync(path.join(output, file), 'utf8');
  const line = text.split('\n').find((line) => line.trim().startsWith(marker));
  if (!line) throw new Error(`Missing actual native receipt: ${file}`);
  const receipts = JSON.parse(line.trim().slice(marker.length));
  const expected = mode || state === 'recognized' ? 5 : 8;
  if (receipts.length !== expected) throw new Error('Exact native receipt cohort required');
  for (const raw of receipts) {
    const result = verifyTournamentCompletionReceipt(raw, raw.tournament_id, 'places', raw.winner_id);
    if (!result || result.rake.accountingState !== state) {
      fs.writeFileSync(path.join(output, 'decoder-rejected-receipt.json'), JSON.stringify(raw, null, 2));
      throw new Error(`Actual native receipt rejected: ${raw.tournament_id}, ${state}`);
    }
    verified++;
  }
}
fs.writeFileSync(path.join(output, 'actual-decoder-proof.json'), JSON.stringify({ mode: mode ?? 'full', verified, source: 'server/src/tournament/completionSettlementReceipt.ts' }, null, 2));
console.log(`PASS actual maintained decoder accepted ${verified} actual native receipts (${mode ?? 'custody and resolved'})`);
