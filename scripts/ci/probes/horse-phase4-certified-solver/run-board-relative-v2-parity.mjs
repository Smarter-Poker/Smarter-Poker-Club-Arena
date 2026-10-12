// Disconnected SQL/TS parity. Refuses TCP/database-provider connections.
// Requires Node with native TypeScript stripping and a private PG17 socket.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// This fixture executes the maintained TS sources directly. Production emits
// .js; only this exact private source dependency is remapped for native stripping.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './GtoBoardRelativeFeaturesV1.js' && context.parentURL?.endsWith('/GtoBoardRelativeFeaturesV2.ts')) {
    return nextResolve('./GtoBoardRelativeFeaturesV1.ts', context);
  }
  return nextResolve(specifier, context);
} });
const { boardRelativeFeatureKeyV2, boardRelativeFeaturesV2 } = await import('../../../../server/src/engine/GtoBoardRelativeFeaturesV2.ts');
const validatorSource = process.env.V31_FEATURE_VALIDATOR_SOURCE;
const validatorModule = await import(validatorSource ? pathToFileURL(validatorSource).href : '../../../../server/src/engine/GtoBoardRelativeFeaturesV2.ts');
const { boardRelativeFeatureKeyV2Valid } = validatorModule;
assert.equal(typeof boardRelativeFeatureKeyV2Valid,'function','actual maintained consumer validator required');

if (!process.env.PGHOST?.startsWith('/Volumes/SmarterWork/agent-work/')) {
  throw Error('parity requires an explicitly task-owned external SSD PostgreSQL socket');
}
const deck = [...'23456789TJQKA'].flatMap((r) => [...'cdhs'].map((s) => r + s));
function combo(hole) {
  const values = hole.map((card) => deck.indexOf(card)).sort((a, b) => a - b);
  assert(values[0] >= 0 && values[0] !== values[1]);
  return values[1] * (values[1] - 1) / 2 + values[0];
}
const vectors = [
  [['Ac','Qd'],['Ks','9d','4c'],0], [['Ac','Qd'],['Qs','8d','3c'],1],
  [['Ac','Qd'],['As','Qc','3c'],2], [['Ac','Ad'],['As','Qc','3c'],3],
  [['Ac','2d'],['3s','4c','5h'],4], [['Ac','Qc'],['8c','5c','3c'],5],
  [['Ac','Ad'],['As','Qc','Qh'],6], [['Ac','Ad'],['As','Ah','3c'],7],
  [['Ac','2c'],['3c','4c','5c'],8], [['Ac','Ad'],['As','Qc','Qd','Qh','3c'],6],
  [['8c','7d'],['6s','5h','Kc'],0], [['Ac','2d'],['3s','4h','Kc'],0],
  [['Ac','Qd'],['Tc','8c','3c'],0], [['Kc','Qd'],['Tc','8c','3c'],0],
  [['2d','3h'],['As','Ks','Qs','Js','Ts'],8],
  [['Ac','Qd'],['Qs','8d','4c'],1],
];
function permutations(rest, prefix = '') {
  return !rest.length ? [prefix] : [...rest].flatMap((s) => permutations(rest.replace(s, ''), prefix + s));
}
for (const permutation of permutations('cdhs')) {
  const remap = (card) => card[0] + permutation['cdhs'.indexOf(card[1])];
  for (const board of [['Qs','8d','3c'], ['Qs','8d','3c','2h'], ['Qs','8d','3c','2h','5s']]) {
    vectors.push([['Ac','Qd'].map(remap).reverse(), board.map(remap).reverse(), 1]);
  }
}
const cases = vectors.map(([hole, board, category], i) => {
  assert.equal(boardRelativeFeaturesV2(hole, board).madeCategory, category);
  return { id: i, index: combo(hole), board: board.join(''), expected: boardRelativeFeatureKeyV2(hole, board) };
});
const invalid = [
  [-1,'Qs8d3c'],[1326,'Qs8d3c'],[combo(['Ac','Qd']),'Ac8d3c'],
  [combo(['Ac','Qd']),'QsQs3c'],[combo(['Ac','Qd']),'qs8d3c'],
  [combo(['Ac','Qd']),'Qs8d'],[combo(['Ac','Qd']),'Qs8d3c2h5s6d'],
].map(([index, board], i) => ({ id: cases.length + i, index, board, expected: null }));
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const rows = [...cases,...invalid].map((item) => `(${item.id},${item.index},${literal(item.board)})`).join(',');
const altered = [
  cases[0].expected.replace('holdem-board-relative-v2','holdem-board-relative-v1'),
  cases[0].expected + ' ', 'null', '{}', '[]',
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 1 ? 6 : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 7 ? 1 : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 4 ? [[0,0,0]] : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 5 ? 0 : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 2 ? 9 : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 11 ? [0,2] : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 8 ? [[0,0],[0,0],[0,0],[0,0]] : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 4 ? [[0,0,12],[0,0,1]] : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 10 ? [[0,-1,-1]] : value)),
  JSON.stringify(JSON.parse(cases[0].expected).map((value,index) => index === 12 ? [0.5,0,0] : value)),
];
const source = readFileSync(new URL('./board-relative-v2.sql', import.meta.url), 'utf8');
const sql = `BEGIN;
DO $$ BEGIN IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'private socket PG17 fixture required'; END IF; END $$;
${source}
WITH inputs(id,combo,board) AS (VALUES ${rows}), computed AS (
 SELECT id,public.fn_gto_v31_board_relative_key_v2(combo,board) AS key FROM inputs
) SELECT jsonb_build_object('vectors',jsonb_agg(jsonb_build_object('id',id,'key',key,'valid',public.fn_gto_v31_board_relative_key_v2_valid(key)) ORDER BY id),
 'invalidKeys',(SELECT jsonb_agg(public.fn_gto_v31_board_relative_key_v2_valid(value)) FROM (VALUES ${altered.map((v) => `(${literal(v)})`).join(',')}) t(value))) FROM computed;
ROLLBACK;`;
const output = execFileSync(process.env.PG17_PSQL ?? '/opt/homebrew/opt/postgresql@17/bin/psql',
  ['-X','-qAt','-v','ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const actual = JSON.parse(output.trim());
for (const item of [...cases,...invalid]) {
  assert.equal(actual.vectors[item.id].key, item.expected, `SQL/TS key differs for vector ${item.id}`);
  if (item.expected !== null) assert.equal(actual.vectors[item.id].valid, true, `generated SQL key rejected for vector ${item.id}`);
  if (item.expected !== null) assert.equal(boardRelativeFeatureKeyV2Valid(item.expected,JSON.parse(item.expected)[1]),actual.vectors[item.id].valid,`TS/SQL valid-key admission differs ${item.id}`);
}
assert(actual.invalidKeys.every((value) => value === false), 'malformed or wrong-version key accepted');
for (const [index,key] of altered.entries()) assert.equal(boardRelativeFeatureKeyV2Valid(key,3),actual.invalidKeys[index],`TS/SQL malformed-key admission differs ${index}`);
console.log(JSON.stringify({fixtureOnly:true,version:'holdem-board-relative-v2',validParityVectors:cases.length,invalidDeckVectors:invalid.length,invalidKeyVectors:altered.length,suitPermutations:24,status:'passed'}));
