#!/usr/bin/env node
/**
 * THE PRICE LIST IN THE CODE AND THE PRICE LIST IN THE DATABASE MUST AGREE.
 * ─────────────────────────────────────────────────────────────────────────
 * Dan 2026-08-27 set the rule: three free per customization category, the rest
 * VIP-locked. That rule now lives in TWO places by necessity —
 *
 *   the TypeScript catalogs   what the picker DRAWS (and greys out)
 *   public.cosmetic_catalog   what the database ENFORCES (trigger on
 *                             user_theme_settings)
 *
 * — and the whole point of the trigger is that the client cannot be trusted
 * to be the guard. If the two lists disagree, the failure is silent and
 * horrible in both directions: a tile the picker offers for free that the
 * database refuses (a player clicks it and nothing happens, forever), or a
 * tile the picker locks that the database would allow (a paid cosmetic given
 * away to anyone who reads the network tab).
 *
 * So this compares them and fails the build on any difference. It is the same
 * shape as check-migrations-applied.mjs: the repo asserts something about the
 * live schema rather than hoping.
 *
 * Runs only when SUPABASE credentials are present; skips (exit 0) otherwise,
 * so a fork or a local checkout without secrets is not blocked.
 *
 * Usage: node scripts/ci/check-cosmetic-catalog-drift.mjs
 * Exit:  0 agree (or skipped) · 1 drift · 2 script error
 */
import { readFileSync } from 'node:fs';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log('check-cosmetic-catalog-drift: SKIPPED (no Supabase credentials in env)');
  process.exit(0);
}

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** Pull `id`/`vipOnly` pairs out of an array literal in a TS source file. */
function parseVipOnlyList(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const end = src.indexOf('];', start);
  const block = src.slice(start, end);
  const out = new Map();
  for (const m of block.matchAll(/id: '([^']+)'[\s\S]{0,240}?vipOnly: (true|false)/g)) {
    out.set(m[1], m[2] === 'true' ? 'vip' : 'free');
  }
  return out;
}

/** FELT_META / BACKGROUND_META style: `id: { ... tier|vipOnly ... }`. */
function parseMetaMap(src, marker, endMarker, kind) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const end = src.indexOf(endMarker, start);
  const block = src.slice(start, end);
  const out = new Map();
  const re =
    kind === 'tier'
      ? /(\w+): \{[\s\S]{0,200}?tier: '(standard|vip)'/g
      : /(\w+): \{ name: '[^']*', vipOnly: (true|false) \}/g;
  for (const m of block.matchAll(re)) {
    out.set(
      m[1],
      kind === 'tier' ? (m[2] === 'vip' ? 'vip' : 'free') : m[2] === 'true' ? 'vip' : 'free'
    );
  }
  return out;
}

const modal = read('src/components/table/ThemeSettingsModal.tsx');
const themeLib = read('src/lib/tableTheme.ts');
const cardImg = read('src/components/table/CardImage.tsx');

const code = {
  theme_id: (() => {
    const start = themeLib.indexOf('THEME_PRESET_CATALOG');
    const end = themeLib.indexOf('];', start);
    if (start === -1 || end === -1) throw new Error('THEME_PRESET_CATALOG not found');
    const block = themeLib.slice(start, end);
    const out = new Map();
    /* THE ID, NOT EVERY FIELD THAT ENDS IN `id` (2026-09-06).
       This was /id: '([^']+)'.../ with no boundary, and every entry in this
       catalog also carries `table_id`, `button_id`, `background_id` and
       `cards_id`. `table_id: 'classic_green'` CONTAINS the substring
       `id: 'classic_green'`, so the scanner read felt asset names as theme
       ids and then reported all nine of them missing from cosmetic_catalog,
       plus all nine real theme ids missing from the code. Every one of those
       eighteen lines was false: the code's ids (default-dark, classic-brown,
       neon-blue ...) match the database exactly.
       The lookbehind rejects a preceding word character, so `table_id:` no
       longer matches and only the entry's own `id:` does. */
    for (const m of block.matchAll(/(?<![\w$])id: '([^']+)'[\s\S]{0,260}?tier: '(free|vip)'/g)) {
      out.set(m[1], m[2]);
    }
    return out;
  })(),
  button_id: parseVipOnlyList(modal, 'BUTTON_ASSETS'),
  background_id: parseMetaMap(
    modal,
    'const BACKGROUND_META',
    'const BACKGROUND_FALLBACK',
    'vipOnly'
  ),
  table_id: parseMetaMap(themeLib, 'const FELT_META', '/** Display order', 'tier'),
  cards_id: (() => {
    // CARD_BACK_CATALOG entries carry `tier: 'standard' | 'premium' | 'exclusive'`.
    const start = cardImg.indexOf('CARD_BACK_CATALOG');
    const end = cardImg.indexOf('];', start);
    const block = cardImg.slice(start, end);
    const out = new Map();
    for (const m of block.matchAll(
      /id: '([^']+)'[\s\S]{0,240}?tier: '(standard|premium|exclusive)'/g
    )) {
      out.set(m[1], m[2] === 'standard' ? 'free' : 'vip');
    }
    return out;
  })(),
};

const res = await fetch(
  `${url.replace(/\/+$/, '')}/rest/v1/cosmetic_catalog?select=category,asset_id,tier`,
  {
    headers: supabaseServerHeaders(key),
  }
);
if (!res.ok) {
  console.error(`check-cosmetic-catalog-drift: cannot read cosmetic_catalog (${res.status})`);
  process.exit(2);
}
const db = new Map();
for (const row of await res.json()) db.set(`${row.category}:${row.asset_id}`, row.tier);

const problems = [];
for (const [category, entries] of Object.entries(code)) {
  const freeInCode = [...entries.values()].filter((t) => t === 'free').length;
  if (freeInCode !== 3) {
    problems.push(`${category}: code offers ${freeInCode} free assets, the rule is exactly 3`);
  }
  for (const [assetId, tier] of entries) {
    const dbTier = db.get(`${category}:${assetId}`);
    if (!dbTier) problems.push(`${category}/${assetId}: in code, MISSING from cosmetic_catalog`);
    else if (dbTier !== tier)
      problems.push(`${category}/${assetId}: code says ${tier}, database says ${dbTier}`);
  }
  for (const key2 of db.keys()) {
    const [cat, ...rest] = key2.split(':');
    if (cat === category && !entries.has(rest.join(':')))
      problems.push(`${category}/${rest.join(':')}: in cosmetic_catalog, MISSING from code`);
  }
}

if (problems.length === 0) {
  console.log('check-cosmetic-catalog-drift: OK — the picker and the trigger agree.');
  process.exit(0);
}
console.error('\nTHE COSMETIC PRICE LIST HAS DRIFTED:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(
  '\nThe picker draws from the TypeScript catalogs; the database trigger on' +
    '\nuser_theme_settings enforces cosmetic_catalog. When they disagree a player' +
    '\neither clicks a free tile that the server refuses forever, or unlocks a paid' +
    '\ncosmetic for nothing. Fix both, in the same PR.'
);
process.exit(1);
