#!/usr/bin/env node
/**
 * multi-table-check.js — logic harness for MULTI-TABLE PLAY (club-arena).
 *
 * Lifts the tab reducers out of src/pages/MultiTablePage.tsx VERBATIM (brace-
 * matched extraction + TypeScript transpile, no re-implementation), stubs the
 * React state plumbing, and drives the full user journey:
 *   join 1 -> + -> lobby tab -> join 2 (cash, via route) -> + -> tournament
 *   drill-down -> join 3 -> + -> join 4 -> attempt 5th -> close 2nd ->
 *   refresh-restore (server-truth rebuild merge).
 * Also asserts, from source, that the + button lives in the HUD's upper-left
 * corner and that inactive table slots are hidden with display:none (kept
 * mounted = engine sockets kept alive), not unmounted.
 *
 * Run: node scripts/multi-table-check.js   (ESM; repo package.json is type:module)
 */
'use strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('src/pages/MultiTablePage.tsx');
const TABLEPAGE = read('src/pages/TablePage.tsx');
const TABBAR = read('src/components/table/TableTabBar.tsx');
const HUD_CSS = read('src/components/table/TableHUD.css');
const HUD_TSX = read('src/components/table/TableHUD.tsx');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// ── verbatim extraction ──────────────────────────────────────────────────────
/** From `anchor`, take the first arrow function AFTER the anchor, verbatim:
 * locate its `=>`, walk BACK over the parenthesized parameter list, then
 * brace-match the body forward. */
function extractArrow(src, anchor) {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found: ' + anchor.slice(0, 60));
  const fat = src.indexOf('=>', i + anchor.length);
  if (fat === -1) throw new Error('no arrow after anchor: ' + anchor.slice(0, 60));
  // back over whitespace to the closing paren of the param list
  let p = fat - 1;
  while (p > 0 && /\s/.test(src[p])) p--;
  if (src[p] !== ')') throw new Error('unparenthesized params after: ' + anchor.slice(0, 60));
  let depth = 0;
  for (; p >= 0; p--) {
    if (src[p] === ')') depth++;
    else if (src[p] === '(') { depth--; if (depth === 0) break; }
  }
  const paramStart = p;
  const braceStart = src.indexOf('{', fat);
  let k = braceStart;
  depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(paramStart, k + 1);
}
function transpile(snippet) {
  return ts.transpileModule('(' + snippet + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
function liftHandler(anchor, params) {
  const snippet = extractArrow(SRC, anchor);
  const js = transpile(snippet);
  // eslint-disable-next-line no-new-func
  return new Function(...params, 'return ' + js + ';');
}

// ── mini React ───────────────────────────────────────────────────────────────
const state = { tables: [], activeIndex: 0 };
const tablesRef = { current: state.tables };
const navCalls = [];
function setTables(v) {
  state.tables = typeof v === 'function' ? v(state.tables) : v;
  tablesRef.current = state.tables; // "render" happened
}
function setActiveIndex(v) {
  state.activeIndex = typeof v === 'function' ? v(state.activeIndex) : v;
}
const user = { id: 'me' };
const goToLobby = () => navCalls.push('lobby');
const navigate = (to) => navCalls.push(to);
const searchParams = { get: () => null };
const MAX_TABLES = (() => {
  const m = SRC.match(/const MAX_TABLES = (\d+);/);
  return m ? Number(m[1]) : NaN;
})();
const LOBBY_TAB_PREFIX = 'lobby:';
const isLobbyTab = (t) => t.kind === 'lobby' || t.id.startsWith(LOBBY_TAB_PREFIX);
const setHomeClubId = () => {};

check('MAX_TABLES is 4 (spec: up to 4 concurrent tables)', MAX_TABLES === 4, 'got ' + MAX_TABLES);

// ── lift each handler verbatim ───────────────────────────────────────────────
const ENV = ['tablesRef', 'setTables', 'setActiveIndex', 'MAX_TABLES', 'LOBBY_TAB_PREFIX',
             'isLobbyTab', 'user', 'goToLobby', 'navigate', 'searchParams'];
const envArgs = [tablesRef, setTables, setActiveIndex, MAX_TABLES, LOBBY_TAB_PREFIX,
                 isLobbyTab, user, goToLobby, navigate, searchParams];

const onSeated = liftHandler("useMasterBusSubscription('TABLE_SEATED', (", ENV)(...envArgs);
const onOpenLobby = liftHandler("useMasterBusSubscription('OPEN_LOBBY_TAB', (", ENV)(...envArgs);
const onCloseTab = liftHandler(
  "useMasterBusSubscription(\n    'TABLE_MENU_ACTION',\n    (", ENV)(...envArgs);
// second TABLE_MENU_ACTION handler (lobby close): search after the first
const firstIdx = SRC.indexOf("'TABLE_MENU_ACTION'");
const secondSrc = SRC.slice(SRC.indexOf("'TABLE_MENU_ACTION'", firstIdx + 1));
const onLobbyClose = (() => {
  const snippet = extractArrow(secondSrc, "'TABLE_MENU_ACTION',");
  return new Function(...ENV, 'return ' + transpile(snippet) + ';')(...envArgs);
})();
const onLeft = liftHandler("useMasterBusSubscription('TABLE_LEFT', (", ENV)(...envArgs);

// route effect: lift the effect body as a function of routeTableId
const routeEffectSnippet = extractArrow(SRC, '// ─── Handle route-based table ID changes');
const routeEffect = new Function(...ENV, 'routeTableId',
  'return ' + transpile(routeEffectSnippet) + ';');
const runRoute = (id) => routeEffect(...envArgs, id)();

// lobby link capture (tournament drill-down)
const captureSnippet = extractArrow(SRC, 'const handleLobbyLinkCapture = useCallback(');
const handleCapture = new Function(...ENV, 'return ' + transpile(captureSnippet) + ';')(...envArgs);
const clearSnippet = extractArrow(SRC, 'const clearLobbyTournament = useCallback(');
const clearLobbyTournament = new Function(...ENV, 'return ' + transpile(clearSnippet) + ';')(...envArgs);

// server-truth rebuild: lift ONLY its setTables updater (the additive merge)
const rebuildUpdaterSnippet = (() => {
  const anchor = 'const known = new Set(prev.map((t) => t.id));';
  const i = SRC.indexOf(anchor);
  if (i === -1) throw new Error('rebuild updater anchor missing');
  const start = SRC.lastIndexOf('(prev) => {', i);
  let depth = 0, k = SRC.indexOf('{', start);
  for (; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, k + 1);
})();
const makeRebuild = new Function('ids', 'tblRows', 'MAX_TABLES',
  'return ' + transpile(rebuildUpdaterSnippet) + ';');

const ids = (ts_) => state.tables.map((t) => (isLobbyTab(t) ? 'LOBBY' : t.id));

// ── SCENARIO ─────────────────────────────────────────────────────────────────
// 1. Sit at first cash table (mount from URL /table/T1)
setTables([{ id: 'T1', name: 'Table 1', stakes: '1/2', isMyTurn: false, pot: 0 }]);
setActiveIndex(0);
onSeated({ tableId: 'T1', userId: 'me', tableName: 'Table 1' });
check('join 1: single tab, no dup from TABLE_SEATED', ids().join(',') === 'T1' && state.activeIndex === 0, ids().join(','));

// 2. "+" -> lobby tab beside the live table
onOpenLobby({});
check('+ opens lobby tab, table 1 stays', ids().join(',') === 'T1,LOBBY', ids().join(','));
check('+ focuses the lobby tab', state.activeIndex === 1, 'active=' + state.activeIndex);
onOpenLobby({});
check('+ twice: one lobby tab only (focus, no stack)', ids().join(',') === 'T1,LOBBY', ids().join(','));

// 3. pick a cash game in the lobby -> <Link to="/table/T2"> -> route effect
runRoute('T2');
check('join 2 (cash): lobby tab converted IN PLACE, no stranded slot',
  ids().join(',') === 'T1,T2', ids().join(','));
check('join 2 focuses the new table', state.activeIndex === 1, 'active=' + state.activeIndex);
onSeated({ tableId: 'T2', userId: 'me' });
check('join 2: later TABLE_SEATED for same table dedups', ids().join(',') === 'T1,T2', ids().join(','));

// 4. "+" again, drill into a TOURNAMENT inside the lobby tab
onOpenLobby({});
const fakeAnchor = { getAttribute: () => '/tournaments/TN9' };
let prevented = false;
handleCapture({
  target: { closest: () => fakeAnchor },
  preventDefault: () => { prevented = true; },
  stopPropagation: () => {},
});
const lobbyTab = state.tables.find(isLobbyTab);
check('tournament card click captured (no route escape)', prevented === true);
check('lobby tab drills into tournament in place',
  lobbyTab && lobbyTab.lobbyTournamentId === 'TN9', JSON.stringify(lobbyTab));
clearLobbyTournament(lobbyTab.id);
check('back-to-lobby clears the drill-down',
  state.tables.find(isLobbyTab).lobbyTournamentId === undefined);
handleCapture({ target: { closest: () => fakeAnchor }, preventDefault: () => {}, stopPropagation: () => {} });
// tournament seats us at T3 -> TournamentDetails navigates /table/T3
runRoute('T3');
check('join 3 (tournament): lobby tab converts to the tournament table',
  ids().join(',') === 'T1,T2,T3', ids().join(','));

// 5. join 4th via TABLE_SEATED (e.g. waitlist seat with lobby tab open)
onOpenLobby({});
onSeated({ tableId: 'T4', userId: 'me' });
check('join 4: TABLE_SEATED converts the open lobby tab',
  ids().join(',') === 'T1,T2,T3,T4', ids().join(','));

// 6. attempt a 5th — every entry point must refuse
onOpenLobby({});
check('cap: + at 4 tables is a no-op', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));
onSeated({ tableId: 'T5', userId: 'me' });
check('cap: TABLE_SEATED for a 5th table refused', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));
runRoute('T5');
check('cap: deep link to a 5th table refused', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));

// other users' seats never spawn tabs
onSeated({ tableId: 'TX', userId: 'someone-else' });
check('other-user TABLE_SEATED filtered out', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));

// 7. close the 2nd table while active on the 4th
setActiveIndex(3);
onLeft({ tableId: 'T2' });
check('remove 2nd: tab gone, order kept', ids().join(',') === 'T1,T3,T4', ids().join(','));
check('remove 2nd: active index follows the same table', state.activeIndex === 2, 'active=' + state.activeIndex);

// CLOSE_TABLE_TAB regression: closing a tab RIGHT of the active one must not yank to 0
setActiveIndex(1);
onCloseTab({ tableId: 'T4', action: 'CLOSE_TABLE_TAB' });
check('close right neighbor: active tab unchanged (yank-to-0 bug fixed)',
  ids().join(',') === 'T1,T3' && state.activeIndex === 1,
  ids().join(',') + ' active=' + state.activeIndex);

// close active tab -> falls back one left
onCloseTab({ tableId: 'T3', action: 'CLOSE_TABLE_TAB' });
check('close active tab: focus moves left', ids().join(',') === 'T1' && state.activeIndex === 0,
  ids().join(',') + ' active=' + state.activeIndex);

// close LAST tab -> lobby tab appears (never a dead end)
onCloseTab({ tableId: 'T1', action: 'CLOSE_TABLE_TAB' });
check('close last tab: lobby tab takes its place', ids().join(',') === 'LOBBY' && state.activeIndex === 0);

// lobby tab X -> lobby handler removes it; TABLE_LEFT on last table goes to club lobby
const lobbyId = state.tables[0].id;
onLobbyClose({ tableId: lobbyId, action: 'FORCE_LEAVE_TABLE' });
check('lobby tab closes via X handler', state.tables.length === 0);
setTables([{ id: 'T1', name: 'T', stakes: '', isMyTurn: false, pot: 0 }]);
navCalls.length = 0;
onLeft({ tableId: 'T1' });
check('TABLE_LEFT on last table returns to the club lobby (navigate once)',
  state.tables.length === 0 && navCalls.length === 1 && navCalls[0] === 'lobby',
  JSON.stringify(navCalls));

// 8. refresh-restore: server-truth rebuild merges every live seat back in
setTables([{ id: 'T1', name: 'Table 1', stakes: '', isMyTurn: false, pot: 0 }]); // from URL
const rebuilt = makeRebuild(
  ['T1', 'T3', 'T4'],
  [
    { id: 'T1', name: 'Alpha', small_blind: 1, big_blind: 2 },
    { id: 'T3', name: 'Bravo', small_blind: 2, big_blind: 5 },
    { id: 'T4', name: 'Charlie', small_blind: null, big_blind: null },
  ],
  MAX_TABLES
)(state.tables);
check('refresh: all live seats restored as tabs (dedup on URL table)',
  rebuilt.map((t) => t.id).join(',') === 'T1,T3,T4', rebuilt.map((t) => t.id).join(','));
check('refresh: stakes mapped from server rows', rebuilt[1].stakes === '2/5', rebuilt[1].stakes);
const rebuiltCap = makeRebuild(['A','B','C','D','E','F'],[],MAX_TABLES)([]);
check('refresh: rebuild honors the 4-cap', rebuiltCap.length === 4, 'len=' + rebuiltCap.length);

// ── tab-bar slot math (lifted values from TableTabBar.tsx) ──────────────────
const slotMath = TABBAR.match(/const emptySlots = maxTables - tabs\.length;/);
check('tab bar: emptySlots = maxTables - tabs.length (verbatim present)', !!slotMath);
const addBtnRender = TABBAR.match(/Math\.min\(emptySlots,\s*(\d+)\)/);
check('tab bar: + buttons render only into empty slots', !!addBtnnull_guard(addBtnRender));
function addBtnnull_guard(m) { return m && Number(m[1]) >= 1 && Number(m[1]) <= 4; }
const defMax = TABBAR.match(/maxTables = (\d+)/);
check('tab bar: default maxTables is 4', !!defMax && defMax[1] === '4');

// ── + button placement: upper-left ───────────────────────────────────────────
const ulStart = TABLEPAGE.indexOf('upperLeft={');
const urStart = TABLEPAGE.indexOf('upperRight={', ulStart);
const ulBlock = TABLEPAGE.slice(ulStart, urStart);
check('+ button markup lives inside the TableHUD upperLeft prop',
  ulStart !== -1 && urStart !== -1 && ulBlock.includes("masterBus.emit('OPEN_LOBBY_TAB'"));
check('+ button labeled as add-table, not cashier',
  ulBlock.includes('Open another table'));
check('HUD renders upperLeft as the first corner of the upper row',
  /table-hud__corner--ul/.test(HUD_TSX) &&
  HUD_TSX.indexOf('table-hud__corner--ul') < HUD_TSX.indexOf('table-hud__corner--ur'));
check('HUD overlay is fixed, full-viewport, space-between (corners pinned)',
  /position: fixed;\s*\n\s*inset: 0;/.test(HUD_CSS) && HUD_CSS.includes('justify-content: space-between'));

// ── keep-alive: hidden slots stay MOUNTED ────────────────────────────────────
check('inactive table slots hidden with display:none (mounted, sockets alive)',
  SRC.includes("style={shouldRender ? undefined : { display: 'none' }}"));
// scan every setTables((prev) => { ... }) body: none may contain a side
// effect (setActiveIndex / navigate via goToLobby) — impure updaters
// double-fire under StrictMode and concurrent re-basing.
const impure = (() => {
  const offenders = [];
  let idx = 0;
  while ((idx = SRC.indexOf('setTables((prev) => {', idx)) !== -1) {
    let depth = 0, k = SRC.indexOf('{', idx + 'setTables(('.length);
    for (; k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}') { depth--; if (depth === 0) break; }
    }
    const body = SRC.slice(idx, k);
    if (body.includes('setActiveIndex') || body.includes('goToLobby()')) {
      offenders.push(SRC.slice(0, idx).split('\n').length); // line number
    }
    idx = k;
  }
  return offenders;
})();
check('no impure updaters: setActiveIndex/navigate never inside a setTables updater',
  impure.length === 0, 'offending setTables at lines ' + impure.join(','));

// ── report ───────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
