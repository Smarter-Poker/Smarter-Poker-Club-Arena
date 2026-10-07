import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const catalog = readFileSync(
  new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
  'utf8'
);
const fields = [
  'd.datacl',
  'spcacl',
  'n.nspacl',
  'c.relacl',
  'a.attacl',
  'p.proacl',
  't.typacl',
  'd.defaclacl',
];

test('all eight catalog ACL fields normalize only complete item ordering and retain NULL separately', () => {
  for (const field of fields) {
    const expression = `CASE WHEN ${field} IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(v::text ORDER BY v::text) FROM unnest(${field}) v),'[]'::jsonb) END`;
    assert.equal(catalog.split(expression).length - 1, 1, field);
    assert.ok(!catalog.includes(`${field}::text`), `${field} raw array ordering is not portable`);
  }
  assert.equal((catalog.match(/jsonb_agg\(v::text ORDER BY v::text\)/g) ?? []).length, 8);
  assert.doesNotMatch(catalog, /aclexplode|acldefault\s*\(/i);
  // Owner, RLS, configuration, identity and view-definition equality stay separate.
  assert.match(catalog, /pg_get_userbyid\(c\.relowner\)/);
  assert.match(catalog, /c\.relrowsecurity,c\.relforcerowsecurity/);
  assert.match(catalog, /p\.prosecdef,p\.proconfig/);
  assert.match(catalog, /md5\(pg_get_viewdef\(c\.oid,false\)\)/);
});

// Independent exact-array oracle, not a substitute for the native PG17 receipt.
const canonical = (acl) => (acl === null ? null : [...acl].sort());
const ownerLast = ['delegate=r*/owner', 'reader=r/delegate', 'owner=arwdDxtm/owner'];

test('order-only ACL differences match while complete grant chain contents remain', () => {
  assert.deepEqual(canonical(ownerLast), canonical([ownerLast[2], ownerLast[0], ownerLast[1]]));
  assert.deepEqual(canonical(null), null);
  assert.deepEqual(canonical([]), []);
  assert.notDeepEqual(canonical(null), canonical([]));
});

test('changed privilege, grant option, grantor, missing and duplicate entries refuse equality', () => {
  for (const replacement of ['reader=w/delegate', 'reader=r/owner']) {
    assert.notDeepEqual(canonical(ownerLast), canonical([ownerLast[0], replacement, ownerLast[2]]));
  }
  assert.notDeepEqual(
    canonical(ownerLast),
    canonical(['delegate=r/owner', ownerLast[1], ownerLast[2]])
  );
  assert.notDeepEqual(canonical(ownerLast), canonical(ownerLast.slice(1)));
  assert.notDeepEqual(canonical(ownerLast), canonical([...ownerLast, ownerLast[0]]));
});
