import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {LEGACY_CENSUS_NATIVE_SOURCE_SHA256, loadLegacyNativeCensus} from '../../server/scripts/legacy-engine-checkpoint.mjs';
const cpp = fs.readFileSync(new URL('../../server/scripts/native/legacy-census.cc',import.meta.url));
const js = fs.readFileSync(new URL('../../server/scripts/legacy-engine-checkpoint.mjs',import.meta.url),'utf8');
test('protected control source pin binds the exact native implementation',()=>{
 assert.equal(createHash('sha256').update(cpp).digest('hex'),LEGACY_CENSUS_NATIVE_SOURCE_SHA256);
});
test('native preallocation ceiling derives from maintained owner and topology ceilings',()=>{
 const limits=JSON.parse(/const limits = (\[[0-9, ]+\]);/.exec(js)[1]);
 const prototypes=Number(/cachedPrototypes >= ([0-9]+)/.exec(js)[1]);
 const terms=/constexpr size_t kMatches = ([0-9 +]+);/.exec(cpp.toString())[1].split('+').map(Number);
 assert.equal(terms.reduce((a,b)=>a+b,0),limits.reduce((a,b)=>a+b,0)+prototypes);
 assert.equal(terms.reduce((a,b)=>a+b,0),22096);
});
test('unowned native descriptors refuse before filesystem access or loading',()=>{
 for (const descriptor of [null,{}, {schema:'legacy-native-census-artifact/v1',path:'/tmp/unowned.node'}])
  assert.throws(()=>loadLegacyNativeCensus(descriptor),/artifact identity refused/);
});
