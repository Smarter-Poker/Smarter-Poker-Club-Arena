#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A HORSE'S AVATAR MUST NOT LIVE AT A PATH THAT SAYS "HORSE"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE
 * OR USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * Measured 2026-09-07: 541 of 1,000 horse profiles carried an `avatar_url`
 * under `social-media/horse-avatars-v2/...` or
 * `social-media/avatars/horse_avatar_<name>_<ts>.png`, and NO human did. The
 * URL is the `src` of an <img> on every seat, every post, every friend card
 * and every messenger thread - it is in the Elements panel and the Network
 * tab of any tab that shows the player. That is the flag, spelled out.
 *
 * This script copies each referenced object to the convention human uploads
 * already use - bucket `avatars`, key `<profile uuid>/avatar.<ext>` - and
 * writes a SQL VALUES list of (profile id, new url) to stdout for the
 * migration that repoints `profiles.avatar_url`. It never deletes the
 * originals: a tab that already holds the old URL keeps rendering, and the
 * originals are removed by a later pass once nothing references them.
 *
 * It reads its credentials from server/.env (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) and never prints them. Idempotent: an object
 * that already exists at the destination is left alone and still listed.
 *
 *   node scripts/ops/copy-horse-avatars-to-neutral-paths.mjs --dry-run
 *   node scripts/ops/copy-horse-avatars-to-neutral-paths.mjs > /tmp/avatar-map.sql
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY = process.argv.includes('--dry-run');

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv(resolve(process.env.HOME, 'Documents/club-arena/server/.env'));
const URL_BASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error('server/.env must carry SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { ...H, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { ok: res.ok, status: res.status, body };
}

const SRC_RE = /\/storage\/v1\/object\/public\/social-media\/((?:horse-avatars-v2|avatars)\/[^?#]+)/;

async function main() {
  // Every horse whose avatar_url says horse. Service role reads is_horse.
  const list = await rest(
    `/rest/v1/profiles?select=id,avatar_url&is_horse=eq.true&avatar_url=imatch.horse-avatars%7Chorse_avatar&limit=2000`
  );
  if (!list.ok) throw new Error(`profiles read ${list.status}: ${JSON.stringify(list.body)}`);
  const rows = list.body;
  console.error(`[avatars] ${rows.length} horse profiles carry a horse-named avatar path`);

  const values = [];
  let copied = 0;
  let existed = 0;
  let failed = 0;
  let done = 0;
  const CONCURRENCY = 8;
  const queue = rows.slice();
  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      await one(row);
      done++;
      if (done % 20 === 0) console.error(`[avatars] ${done}/${rows.length}`);
    }
  };
  async function one(row) {
    const m = row.avatar_url.match(SRC_RE);
    if (!m) {
      console.error(`[avatars] SKIP ${row.id}: unrecognised url ${row.avatar_url}`);
      failed++;
      return;
    }
    const sourceKey = m[1];
    const ext = (sourceKey.split('.').pop() || 'png').toLowerCase();
    const destinationKey = `${row.id}/avatar.${ext}`;
    const newUrl = `${URL_BASE}/storage/v1/object/public/avatars/${destinationKey}`;

    if (!DRY) {
      // Already there? (idempotent re-runs)
      const head = await fetch(newUrl, { method: 'HEAD' });
      if (head.ok) {
        existed++;
      } else {
        const copy = await rest('/storage/v1/object/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bucketId: 'social-media',
            sourceKey,
            destinationBucket: 'avatars',
            destinationKey,
          }),
        });
        if (!copy.ok) {
          // Older Storage builds copy within a bucket only: download + upload.
          const dl = await fetch(`${URL_BASE}/storage/v1/object/public/social-media/${sourceKey}`);
          if (!dl.ok) {
            console.error(`[avatars] FAIL ${row.id}: source ${dl.status}`);
            failed++;
            return;
          }
          const bytes = Buffer.from(await dl.arrayBuffer());
          const up = await rest(`/storage/v1/object/avatars/${destinationKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': dl.headers.get('content-type') || `image/${ext}`,
              'x-upsert': 'true',
            },
            body: bytes,
          });
          if (!up.ok) {
            console.error(`[avatars] FAIL ${row.id}: upload ${up.status} ${JSON.stringify(up.body)}`);
            failed++;
            return;
          }
        }
        const verify = await fetch(newUrl, { method: 'HEAD' });
        if (!verify.ok) {
          console.error(`[avatars] FAIL ${row.id}: destination not readable after copy (${verify.status})`);
          failed++;
          return;
        }
        copied++;
      }
    }
    values.push(`('${row.id}'::uuid, '${newUrl}')`);
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.error(
    `[avatars] copied=${copied} already_present=${existed} failed=${failed} listed=${values.length}${DRY ? ' (dry run: nothing copied)' : ''}`
  );
  process.stdout.write(values.join(',\n') + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
