#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN OBJECT NAME A STRANGER CAN LIST MUST NOT SAY "HORSE"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE
 * OR USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * `storage.objects` carries the policy `preset_avatars_are_listable`:
 *
 *     FOR SELECT TO anon, authenticated
 *     USING (bucket_id = 'social-media' AND name LIKE 'avatars/%')
 *
 * so ANYONE, signed out, can LIST that prefix. 219 objects in it were named
 * `avatars/horse_avatar_<profile uuid>_<ts>.png`. The name is the roster: the
 * uuid is the horse's profile id, spelled out in a listing a stranger can ask
 * for. Reading the picture was never the leak; being able to enumerate the
 * names was.
 *
 * Every one of them was copied to `avatars/<uuid>/avatar.<ext>` in the
 * `avatars` bucket first and each destination was verified to answer 200, and
 * no row in `profiles` or `content_authors` points at the old path any more
 * (migrations 20260908022510 and 20260908031934, both applied and asserted).
 * So these are unreferenced duplicates whose NAMES are the problem, and the
 * fix is to remove them.
 *
 * It refuses to delete anything still referenced, and it only ever touches the
 * listable prefix - `horse-avatars-v2/` is not covered by that policy and is
 * left alone for a later pass, once open tabs have cycled.
 *
 *   node scripts/ops/delete-listable-horse-avatar-objects.mjs --dry-run
 *   node scripts/ops/delete-listable-horse-avatar-objects.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const env = Object.fromEntries(
  readFileSync(resolve(process.env.HOME, 'Documents/club-arena/server/.env'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
);
const U = env.SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
if (!U || !K) {
  console.error('server/.env must carry SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
const H = {
  apikey: K,
  Authorization: `Bearer ${K}`,
  'x-smarter-data-actor': 'service',
  'x-smarter-data-protocol': '1',
};

const q = async (path) => (await fetch(`${U}${path}`, { headers: H })).json();

// Nothing may still reference the horse-named paths.
for (const [table, filter] of [
  ['profiles', 'avatar_url=imatch.horse-avatars%7Chorse_avatar'],
  ['content_authors', 'avatar_url=imatch.horse-avatars%7Chorse_avatar'],
]) {
  const rows = await q(`/rest/v1/${table}?select=id&${filter}&limit=1`);
  if (Array.isArray(rows) && rows.length > 0) {
    console.error(`REFUSING: ${table} still references a horse-named avatar path`);
    process.exit(1);
  }
}

// The listing comes from storage's own API, which is what a stranger would use.
const listed = await (
  await fetch(`${U}/storage/v1/object/list/social-media`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'avatars/', limit: 5000, offset: 0 }),
  })
).json();

const targets = (Array.isArray(listed) ? listed : [])
  .map((o) => o.name)
  .filter((n) => typeof n === 'string' && n.startsWith('horse_avatar_'))
  .map((n) => `avatars/${n}`);

console.error(`[objects] ${targets.length} listable objects named horse_avatar_*`);
if (DRY || targets.length === 0) {
  console.error(DRY ? '(dry run: nothing deleted)' : '(nothing to do)');
  process.exit(0);
}

const res = await fetch(`${U}/storage/v1/object/social-media`, {
  method: 'DELETE',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefixes: targets }),
});
console.error(`[objects] delete ${res.status}`);

const after = await (
  await fetch(`${U}/storage/v1/object/list/social-media`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'avatars/', limit: 5000, offset: 0 }),
  })
).json();
const left = (Array.isArray(after) ? after : []).filter((o) =>
  String(o.name).startsWith('horse_avatar_')
).length;
console.error(`[objects] still listable and horse-named: ${left}`);
process.exit(left === 0 ? 0 : 1);
