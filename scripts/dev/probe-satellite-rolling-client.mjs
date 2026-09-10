import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = 'bb7a6ba30639fdfc5ae81df52d4e9f0b7c6afa9a';
const source = execFileSync('git', ['-C', repo, 'show', ref + ':src/pages/TablePage.tsx'], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
const parsed = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let callback;
function walk(n) {
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'exitFromDurableCompletion')
    callback = n.getText(parsed);
  ts.forEachChild(n, walk);
}
walk(parsed);
if (!callback) throw Error('Missing actual legacy callback');
const js = ts.transpileModule(callback, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const run = new Function(
  'row',
  `
let durableCompletionLookupInFlight=false,durableCompletionHandled=false,isMounted=true,userId='viewer';
const durableTournamentId='source',durableTournamentName='Legacy Satellite';
let durableCompletionFailureReported=false,durableCompletionRetryTimer=null;
const observed={retries:0,exits:[],winners:[],errors:[]};
const supabase={from(){return {select(){return this},eq(){return this},async maybeSingle(){return {data:row,error:null}}}}};
function scheduleDurableCompletionRetry(){observed.retries++}
function reportError(...a){observed.errors.push(a)}
function setTournamentWinner(a){observed.winners.push(a)}
function formatGameTitle(s){return s}
function goToLobbyWithResult(...a){observed.exits.push(a)}
` +
    js +
    `;return exitFromDurableCompletion().then(()=>observed);`
);
const rows = [];
for (const [label, row] of [
  ['placeless qualifier', { status: 'winner', position: null, prize: 200 }],
  ['ranked winner control', { status: 'winner', position: 1, prize: 200 }],
  ['ranked loser control', { status: 'eliminated', position: 2, prize: 0 }],
])
  rows.push({ label, row, observed: await run(row) });
if (rows[0].observed.retries !== 1 || rows[0].observed.exits.length)
  throw Error('Placeless old-client counterexample changed');
if (rows[1].observed.exits[0][0] !== 1 || rows[2].observed.exits[0][0] !== 2)
  throw Error('Legacy ranked controls failed');
const shellSource = execFileSync(
  'git',
  ['-C', repo, 'show', ref + ':src/hooks/useShellUpdateGate.ts'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
);
const shellParsed = ts.createSourceFile('gate.ts', shellSource, ts.ScriptTarget.Latest, true);
const shellPure = shellParsed.statements
  .filter(
    (n) =>
      ts.isVariableStatement(n) ||
      (ts.isFunctionDeclaration(n) && n.name?.text !== 'useShellUpdateGate')
  )
  .map((n) => n.getText(shellParsed))
  .join('\n');
const shellJs = ts.transpileModule(shellPure, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
new Function('exports', 'require', shellJs)(exports, () => ({}));
const reloads = [
  '/hub/club-arena/table/old-source',
  '/table/old-source',
  '/hub/club-arena/lobby',
].map((pathname) => ({
  pathname,
  allowed: exports.mayReloadForShell({ pathname, visible: true, lastReloadAt: null, now: 1000000 }),
}));
if (reloads[0].allowed || reloads[1].allowed || !reloads[2].allowed)
  throw Error('Existing safe route reload gate changed');

let seatNode;
function seatWalk(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText(parsed) === 'applySeatRemoved') seatNode = n;
  ts.forEachChild(n, seatWalk);
}
seatWalk(parsed);
if (!seatNode) throw Error('Missing actual legacy seat removal callback');
const seatObserved = {
  state: { heroSeat: 1, players: [{ id: 'viewer' }] },
  notices: [],
  exits: [],
};
const seatDeps = {
  useCallback: (fn) => fn,
  leftSeatPendingRef: { current: false },
  userId: 'viewer',
  heroSeatRef: { current: 1 },
  sittingOutIdsRef: { current: new Set(['viewer']) },
  setHeroSitsOutPerRow() {},
  setShowSitOut() {},
  setSitOutSince() {},
  setSitOutNextHand() {},
  setTableState: (fn) => (seatObserved.state = fn(seatObserved.state)),
  bootNoticeShownRef: { current: false },
  heartbeatToastRef: { current: { info: (x) => seatObserved.notices.push(x) } },
  BOOT_EXPLANATIONS: {},
  tableStateRef: { current: { isTournament: true } },
  navigate: (x) => seatObserved.exits.push(x),
  masterBus: { emit: (x) => seatObserved.exits.push(x) },
};
const seatJs = ts.transpileModule(
  'const ' + seatNode.getText(parsed) + ';return applySeatRemoved;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
new Function(...Object.keys(seatDeps), seatJs)(...Object.values(seatDeps))(undefined, {
  announce: false,
});
if (
  seatObserved.state.heroSeat !== 0 ||
  seatObserved.state.players[0] !== null ||
  seatObserved.exits.length
)
  throw Error('Legacy seat removal behavior changed');
const multiSource = execFileSync(
  'git',
  ['-C', repo, 'show', ref + ':src/pages/MultiTablePage.tsx'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
);
const multiParsed = ts.createSourceFile(
  'MultiTablePage.tsx',
  multiSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let rebuild;
function multiWalk(n) {
  if (
    ts.isArrowFunction(n) &&
    ts.isCallExpression(n.parent) &&
    n.parent.expression.getText(multiParsed) === 'useEffect' &&
    n.getText(multiParsed).includes('pruneStaleSeatedTabs(prev, liveSeatIds)')
  )
    rebuild = n.getText(multiParsed);
  ts.forEachChild(n, multiWalk);
}
multiWalk(multiParsed);
if (!rebuild) throw Error('Missing actual legacy seat rebuild');
const zeroObserved = { tableMutations: 0, readyCalls: 0 };
const zeroDeps = {
  user: { id: 'viewer' },
  supabase: {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async is() {
          return { data: [], error: null };
        },
      };
    },
  },
  setTables() {
    zeroObserved.tableMutations++;
  },
  setTablesReady() {
    zeroObserved.readyCalls++;
  },
};
const rebuildJs = ts.transpileModule('const run=' + rebuild + ';return run;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const stopRebuild = new Function(...Object.keys(zeroDeps), rebuildJs)(...Object.values(zeroDeps))();
await new Promise((resolve) => setTimeout(resolve, 0));
stopRebuild();
if (zeroObserved.tableMutations !== 0 || zeroObserved.readyCalls !== 0)
  throw Error('Legacy zero-seat early return changed');

const proof = {
  source_ref: ref,
  source_sha256: createHash('sha256').update(source).digest('hex'),
  actual_legacy_callback_sha256: createHash('sha256').update(callback).digest('hex'),
  legacy_has_qualification_event: source.includes('tournament_qualified'),
  legacy_has_qualification_rpc: source.includes('fn_get_my_satellite_qualification'),
  terminal_callbacks: rows,
  seat_removal: seatObserved,
  successful_empty_seat_read: zeroObserved,
  multi_source_sha256: createHash('sha256').update(multiSource).digest('hex'),
  seat_removal_callback_sha256: createHash('sha256').update(seatNode.getText(parsed)).digest('hex'),
  rebuild_callback_sha256: createHash('sha256').update(rebuild).digest('hex'),
  reload_gate: reloads,
  limit:
    'Actual source-extracted callbacks with mocked read transport; not an authenticated browser or live settlement claim.',
};
writeFileSync(
  resolve(repo, 'docs/audits/2026-09-10-satellite-rolling-client/legacy-behavior-proof.json'),
  JSON.stringify(proof, null, 2) + '\n'
);
console.log(JSON.stringify(proof, null, 2));
