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
 * 2026-08-19 persistence invariants (container lifted ABOVE the router):
 * MultiTablePage is mounted once by PersistentTableLayer beside <Routes> and
 * merely hides on non-/table routes, so a lobby->cashier->lobby walk leaves
 * the mounted tab set (= the engine-socket registry, sockets are owned by the
 * mounted TablePage instances) untouched; the global LiveTablesBar dock
 * surfaces "Return to game" / "Action needed" while hidden; auto-switch and
 * keyboard shortcuts are inert off-route.
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
// Dan 2026-08-20: the cap no longer fails silently — every refusal calls
// notifyCapReached(reason). Record the calls so the harness can PROVE the
// player is told, instead of only proving the fifth table was refused.
const capNotices = [];
const notifyCapReached = (reason) => capNotices.push(reason);
const activeIndexRef = { current: 0 };

check('MAX_TABLES is 4 (spec: up to 4 concurrent tables)', MAX_TABLES === 4, 'got ' + MAX_TABLES);

// ── lift each handler verbatim ───────────────────────────────────────────────
const ENV = ['tablesRef', 'setTables', 'setActiveIndex', 'MAX_TABLES', 'LOBBY_TAB_PREFIX',
             'isLobbyTab', 'user', 'goToLobby', 'navigate', 'searchParams',
             'notifyCapReached', 'activeIndexRef'];
const envArgs = [tablesRef, setTables, setActiveIndex, MAX_TABLES, LOBBY_TAB_PREFIX,
                 isLobbyTab, user, goToLobby, navigate, searchParams,
                 notifyCapReached, activeIndexRef];

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
// droppedRef records how many live seats did not fit on the device, so the
// caller can tell the player. The harness reads it to assert the priority.
const droppedRef = { current: 0 };
const makeRebuild = new Function('ids', 'tblRows', 'MAX_TABLES', 'droppedRef',
  'return ' + transpile(rebuildUpdaterSnippet) + ';');
const makeRebuildBound = (ids, tblRows, cap) => makeRebuild(ids, tblRows, cap, droppedRef);

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

// 6. attempt a 5th — every entry point must refuse AND SAY SO.
// Dan 2026-08-20: refusing silently is the bug, not the fix. A player at four
// tables who taps "+" (or is engine-seated into a tournament, or follows a
// tournament deep link) must be told why nothing opened; the old code just
// `return`ed and left them staring at the wrong table.
capNotices.length = 0;
onOpenLobby({});
check('cap: + at 4 tables is a no-op', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));
check('cap: + at 4 tables TELLS the player', capNotices.includes('add'),
  'notices=' + JSON.stringify(capNotices));

capNotices.length = 0;
onSeated({ tableId: 'T5', userId: 'me' });
check('cap: TABLE_SEATED for a 5th table refused', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));
check('cap: engine-seated 5th table TELLS the player (tournament blind-out guard)',
  capNotices.includes('seated'), 'notices=' + JSON.stringify(capNotices));

capNotices.length = 0;
navCalls.length = 0;
activeIndexRef.current = 1; // player is looking at T2
runRoute('T5');
check('cap: deep link to a 5th table refused', ids().join(',') === 'T1,T2,T3,T4', ids().join(','));
check('cap: deep link to a 5th table TELLS the player', capNotices.includes('route'),
  'notices=' + JSON.stringify(capNotices));
check('cap: deep link puts the URL back on the table actually on screen',
  navCalls.includes('/table/T2'), 'nav=' + JSON.stringify(navCalls));

// Dan 2026-08-20: the notice throttle is keyed PER REASON. A single shared
// window meant a player who tapped "+" and was then seated into a tournament
// by the engine within four seconds got the trivial notice and had the
// money-critical one dropped. Lift the real implementation and prove it.
{
  const src = SRC.slice(SRC.indexOf('const notifyCapReached'), SRC.indexOf('// ─── Table Management'));
  check('cap: notices are throttled per reason, not globally',
    /capNoticeAtRef\s*=\s*useRef<Record<string, number>>/.test(SRC) &&
    src.includes("reason === 'seated' ? 'seated' : 'user-action'"),
    'throttle key not per-reason');

  // Behavioural: replay the real keying logic.
  const at = {};
  const fire = (reason, now) => {
    const key = reason === 'seated' ? 'seated' : 'user-action';
    if (now - (at[key] ?? 0) < 4000) return false;
    at[key] = now;
    return true;
  };
  // Epoch-scale values on purpose: with a 0 initial timestamp any 'now' under
  // 4000 throttles the very FIRST call, which is an artefact of small test
  // numbers and not something that can happen against a real Date.now().
  const T = 1787000000000;
  check('cap: a "+" notice does NOT swallow the tournament-seating notice',
    fire('add', T) === true && fire('seated', T + 500) === true);
  check('cap: repeated "+" within the window is still throttled',
    fire('add', T + 1000) === false);
  check('cap: repeated seating within the window is still throttled',
    fire('seated', T + 1200) === false);
  check('cap: each reason reopens independently after its own window',
    fire('add', T + 5000) === true && fire('seated', T + 5100) === true);
}

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
const rebuilt = makeRebuildBound(
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
droppedRef.current = 0;
const rebuiltCap = makeRebuildBound(['A','B','C','D','E','F'],[],MAX_TABLES)([]);
check('refresh: rebuild honors the 4-cap', rebuiltCap.length === 4, 'len=' + rebuiltCap.length);
check('refresh: overflow is recorded so the player can be told',
  droppedRef.current === 2, 'dropped=' + droppedRef.current);

// Dan 2026-08-20: the server caps CASH seats at four but never caps tournament
// seats, so a returning player CAN legitimately hold more live seats than the
// device shows. Which four get restored is not arbitrary: a tournament seat
// cannot be walked away from (miss it and you blind out of something you paid
// to enter), a cash seat can be left any time with the stack refunded.
droppedRef.current = 0;
const mixedRows = [
  { id: 'C1', name: 'Cash 1', small_blind: 1, big_blind: 2, tournament_id: null },
  { id: 'C2', name: 'Cash 2', small_blind: 1, big_blind: 2, tournament_id: null },
  { id: 'C3', name: 'Cash 3', small_blind: 1, big_blind: 2, tournament_id: null },
  { id: 'V1', name: 'MTT A', small_blind: 50, big_blind: 100, tournament_id: 'tourA' },
  { id: 'V2', name: 'MTT B', small_blind: 50, big_blind: 100, tournament_id: 'tourB' },
];
const mixed = makeRebuildBound(['C1','C2','C3','V1','V2'], mixedRows, MAX_TABLES)([]);
check('refresh: tournament seats are restored BEFORE cash seats when over cap',
  mixed.slice(0, 2).map((t) => t.id).sort().join(',') === 'V1,V2',
  mixed.map((t) => t.id).join(','));
check('refresh: no tournament seat is ever the one dropped',
  !['V1','V2'].some((id) => !mixed.find((t) => t.id === id)),
  mixed.map((t) => t.id).join(','));
check('refresh: overflow count is exact for the mixed case',
  droppedRef.current === 1, 'dropped=' + droppedRef.current);
check('refresh: cash-only order is left alone when everything fits',
  makeRebuildBound(['C1','C2'], mixedRows, MAX_TABLES)([])
    .map((t) => t.id).join(',') === 'C1,C2');

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


// ═════════════════════════════════════════════════════════════════════════════
// PERSISTENCE INVARIANTS (2026-08-19: container lifted above the router)
// ═════════════════════════════════════════════════════════════════════════════
const APP = read('src/App.tsx');
const LAYER = read('src/components/table/PersistentTableLayer.tsx');
const ENGINE_HOOK = read('src/hooks/useEngineTableState.ts');
const CLUB_HOME = read('src/pages/ClubHomePage.tsx');

// -- the container survives route changes by construction ---------------------
check('persist: PersistentTableLayer mounted OUTSIDE <Routes> (sibling, never unmounts)',
  APP.includes('<PersistentTableLayer />') &&
  APP.lastIndexOf('<PersistentTableLayer />') > APP.indexOf('</Routes>') &&
  APP.lastIndexOf('<PersistentTableLayer />') < APP.indexOf('</TOSGuard>'));
check('persist: /table route element no longer mounts MultiTablePage',
  !/path="table\/:tableId"[\s\S]{0,600}?<MultiTablePage/.test(APP) &&
  /path="table\/:tableId"[\s\S]{0,600}?<TableRouteSurface \/>/.test(APP));
check('persist: layer renders MultiTablePage (auth-gated, own Suspense)',
  LAYER.includes('<MultiTablePage />') && LAYER.includes('if (!user) return null;'));
check('persist: hidden container collapses via display:none, NOT unmount',
  SRC.includes("style={hidden ? { display: 'none' } : undefined}"));

// -- socket ownership: EngineStateClient lives under what now persists --------
check('sockets: EngineStateClient constructed ONLY in useEngineTableState (TablePage-owned)',
  ENGINE_HOOK.includes('new EngineStateClient') &&
  !SRC.includes('new EngineStateClient') &&
  !TABLEPAGE.includes('new EngineStateClient') &&
  !APP.includes('new EngineStateClient'));

// -- simulated route walk: lobby -> cashier -> lobby --------------------------
setTables([
  { id: 'T1', name: 'Alpha', stakes: '1/2', isMyTurn: false, pot: 0 },
  { id: 'T2', name: 'Bravo', stakes: '2/5', isMyTurn: false, pot: 0 },
]);
setActiveIndex(1);
const walkBefore = state.tables; // identity = "socket registry" of mounted tabs
runRoute(undefined); // /clubs/:id (lobby)
runRoute(undefined); // /cashier
runRoute(undefined); // back to the lobby
check('route walk: tab set identity unchanged across lobby->cashier->lobby (no setTables fired)',
  state.tables === walkBefore && state.activeIndex === 1,
  'identity=' + (state.tables === walkBefore) + ' active=' + state.activeIndex);

// returning to an ALREADY-mounted table focuses its tab instead of ignoring it
runRoute('T1');
check('route walk: /table/:id for a mounted table focuses that tab (no dup, no ignore)',
  state.tables === walkBefore && state.activeIndex === 0,
  ids().join(',') + ' active=' + state.activeIndex);

// -- global dock: urgent-alert surfaced when route is not /table/* ------------
const dockSnippet = extractArrow(SRC, 'const dockStateFor = (');
const dockStateFor = new Function(...ENV, 'return ' + transpile(dockSnippet) + ';')(...envArgs);
const quiet = [
  { id: 'T1', name: 'Alpha', isMyTurn: false, pot: 0 },
  { id: 'T2', name: 'Bravo', isMyTurn: false, pot: 0 },
  { id: 'lobby:1', kind: 'lobby', name: 'Lobby', isMyTurn: false, pot: 0 },
];
check('dock: nothing rendered while ON /table/* (container itself is visible)',
  dockStateFor(quiet, false, 1000).kind === 'none');
const dq = dockStateFor(quiet, true, 1000);
check('dock: quiet hidden tables -> Return-to-game with live-table count (lobby tabs excluded)',
  dq.kind === 'return' && dq.count === 2 && dq.targetId === 'T1', JSON.stringify(dq));
const withTurn = [
  { id: 'T1', name: 'Alpha', isMyTurn: false, pot: 0 },
  { id: 'T2', name: 'Bravo', isMyTurn: true, turnDeadlineMs: 7500, pot: 0 },
];
const du = dockStateFor(withTurn, true, 1000);
check('dock: hidden table on the hero\'s action -> urgent alert with countdown',
  du.kind === 'urgent' && du.targetId === 'T2' && du.name === 'Bravo' && du.secondsLeft === 7,
  JSON.stringify(du));
const twoTurns = [
  { id: 'T1', name: 'Alpha', isMyTurn: true, turnDeadlineMs: 9000, pot: 0 },
  { id: 'T2', name: 'Bravo', isMyTurn: true, turnDeadlineMs: 4000, pot: 0 },
];
check('dock: most pressing deadline wins when several tables want action',
  dockStateFor(twoTurns, true, 1000).targetId === 'T2');
// Dan 2026-08-20: the quiet dock used to always hand back the OLDEST tab, so a
// player who wandered off table 4 was dropped onto table 1 and had to find
// their way back. It now prefers the last table they actually had on screen.
check('dock: quiet return goes to the LAST-VIEWED table, not the oldest tab',
  dockStateFor(quiet, true, 1000, 'T2').targetId === 'T2',
  JSON.stringify(dockStateFor(quiet, true, 1000, 'T2')));
check('dock: last-viewed falls back to the first live tab when that table is gone',
  dockStateFor(quiet, true, 1000, 'T-closed').targetId === 'T1');
check('dock: an urgent table still outranks the last-viewed one',
  dockStateFor(withTurn, true, 1000, 'T1').targetId === 'T2');
check('dock: rendered through LiveTablesBar with the urgent payload wired',
  SRC.includes('hidden && dock.kind !== \'none\'') && SRC.includes('<LiveTablesBar') &&
  SRC.includes('onReturn={handleDockReturn}'));
check('dock: exactly one affordance — ClubHomePage no longer renders its own bar',
  !CLUB_HOME.includes('<LiveTablesBar'));

// -- off-route inertness: no route yank, no key hijack -------------------------
const autoBlock = SRC.slice(
  SRC.indexOf('Auto-switch on urgent timer'),
  SRC.indexOf('Keyboard shortcuts for table switching'));
check('auto-switch: gated to /table/* (surfaces the dock instead of yanking the route)',
  autoBlock.includes('if (hidden) return;'));
const kbBlock = SRC.slice(
  SRC.indexOf('Keyboard shortcuts for table switching'),
  SRC.indexOf('Swipe Gesture Handling'));
check('keyboard shortcuts: inert while hidden (no Tab/1-4 hijack on other pages)',
  kbBlock.includes('if (hidden) return;'));
// Dan 2026-08-20: the WS_* handlers used to churn a new tables array on every
// realtime blip to drive a "disconnection indicator" that did not exist. Assert
// both halves of the fix: no array churn, and a real chip that is actually fed.
check('realtime: WS handlers no longer churn the tables array',
  !/WS_DISCONNECTED', \(\) => \{[\s\S]{0,120}setTables/.test(SRC) &&
  SRC.includes("useMasterBusSubscription('WS_DISCONNECTED', () => setRealtimeDown(true))"));
check('realtime: reconnect clears the warning (WS_CONNECTED subscribed)',
  SRC.includes("useMasterBusSubscription('WS_CONNECTED', () => setRealtimeDown(false))"));
check('realtime: the warning is actually rendered (fed to TableTabBar)',
  SRC.includes('realtimeDown={realtimeDown}') &&
  TABBAR.includes('table-tab-bar__offline') && TABBAR.includes('realtimeDown'));

check('hidden tables muted: no ambient sound follows the player off-route',
  SRC.includes('isActive={idx === activeIndex && !hidden}') &&
  SRC.includes('isMultiTable={tables.length > 1 || hidden}'));

// ── report ───────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
