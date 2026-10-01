/**
 * THE WALK PLAYS ONLY WHERE NOTHING IS REAL (decided 2026-09-30).
 *
 * multitable-walk.mjs buys in at cash tables and plays. Until 2026-09-30 it
 * did that at the cheapest open table in Club JAQK, a real club where horses
 * play and people may sit, as whatever account the operator supplied. That
 * put real chips at real tables under any account the operator signed in as.
 * Decided by Claude on Dan's delegation of 2026-09-30 (Dan: "these are all for
 * you to decide not me ... FIX AND FINISH ALL OF THESE"; docs/DIAMOND-RULINGS.md
 * Ruling 23): the walk is retired from production play. It refuses to start
 * unless BOTH of these hold.
 *
 *   1. It signs in as a test identity. The estate's test-account marker is an
 *      address under the reserved `.invalid` top-level domain
 *      (fn_ca_is_fixture_account; the post-deploy accounts are
 *      `...@example.invalid`, the older ones `...@smarter-poker.invalid`). No
 *      person can hold such an address. The account named by SP_EMAIL, the
 *      account in the saved browser state, and the account the page is signed
 *      in as are each checked.
 *   2. It targets a club flagged as a test club: E2E_TEST_CLUB names it (uuid
 *      or slug), and its row carries the tag `test-club` in clubs.tags. The
 *      estate's real clubs (Club JAQK, SHARK CLUB, Deep Stack Society, Midway
 *      Union) are refused whatever their tags say. A Diamond club, or a
 *      retired one, is refused too.
 *
 * Each refusal happens before a browser opens or a seat is taken. The club
 * check reads the public clubs row through the REST API, so it needs the
 * project's public URL and anon key (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
 * Without them the club cannot be checked, and the walk refuses.
 */
import fs from 'fs';

export const TEST_IDENTITY_SUFFIX = '.invalid';
export const TEST_CLUB_TAG = 'test-club';
export const AUTH_STORAGE_KEY = 'smarter-poker-auth';
const DEFAULT_SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const REAL_CLUBS = new Set([
  'a0000000-0000-0000-0000-000000000001', // Club JAQK
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4', // SHARK CLUB
  '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', // Deep Stack Society
  'fade0000-0000-0000-0000-000000000001', // Midway Union
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Refusal extends Error {}

export function isTestIdentity(email) {
  return (
    typeof email === 'string' &&
    /^[^@\s]+@[^@\s]+$/.test(email.trim()) &&
    email.trim().toLowerCase().endsWith(TEST_IDENTITY_SUFFIX)
  );
}

/** The signed-in account's email in a saved Playwright storage state, or null. */
export function identityInStorageState(path) {
  if (!path || !fs.existsSync(path)) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    throw new Refusal(
      `the saved browser state ${path} cannot be read, so its account cannot be checked`
    );
  }
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) {
      if (item.name !== AUTH_STORAGE_KEY && !/^sb-.*-auth-token$/.test(item.name)) continue;
      try {
        const session = JSON.parse(item.value);
        const email = session?.user?.email ?? session?.currentSession?.user?.email;
        if (email) return email;
      } catch {
        /* not a session value */
      }
    }
  }
  return null;
}

/** Refuses unless every account this run could act as is a test identity. */
export function requireTestIdentity({ email = process.env.SP_EMAIL, authPath } = {}) {
  const stored = identityInStorageState(authPath);
  const named = email && email.trim() ? email.trim() : null;
  if (!named && !stored) {
    throw new Refusal(
      'no account is named (SP_EMAIL) and no saved browser state holds one; refusing to guess an account'
    );
  }
  for (const [source, who] of [
    ['SP_EMAIL', named],
    ['the saved browser state', stored],
  ]) {
    if (who && !isTestIdentity(who)) {
      throw new Refusal(
        `${source} is ${who}, which is not a test identity (an address ending in ${TEST_IDENTITY_SUFFIX})`
      );
    }
  }
  if (named && stored && named.toLowerCase() !== stored.toLowerCase()) {
    throw new Refusal(
      `SP_EMAIL (${named}) and the saved browser state (${stored}) are different accounts`
    );
  }
  return named || stored;
}

/** Refuses unless the page is signed in as the checked test identity. */
export async function requirePageIdentity(page, expected) {
  const email = await page
    .evaluate((key) => {
      try {
        const session = JSON.parse(window.localStorage.getItem(key) || 'null');
        return session?.user?.email ?? session?.currentSession?.user?.email ?? null;
      } catch {
        return null;
      }
    }, AUTH_STORAGE_KEY)
    .catch(() => null);
  if (
    !email ||
    !isTestIdentity(email) ||
    (expected && email.toLowerCase() !== expected.toLowerCase())
  ) {
    throw new Refusal(
      `the page is signed in as ${email || 'nobody'}, not the test identity ${expected}`
    );
  }
  return email;
}

/** Reads the target club and refuses unless it is flagged as a test club. */
export async function requireTestClub({
  club = process.env.E2E_TEST_CLUB,
  supabaseUrl = process.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL,
  anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = club && club.trim();
  if (!key)
    throw new Refusal(`no test club is named; set E2E_TEST_CLUB to a club tagged ${TEST_CLUB_TAG}`);
  if (!anonKey)
    throw new Refusal('VITE_SUPABASE_ANON_KEY is not set, so the club cannot be checked; refusing');
  const filter = UUID.test(key) ? `id=eq.${key}` : `slug=eq.${encodeURIComponent(key)}`;
  const res = await fetchImpl(
    `${supabaseUrl}/rest/v1/clubs?select=id,name,slug,tags,asset,lifecycle_status&${filter}`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
  );
  if (!res.ok)
    throw new Refusal(`the club ${key} could not be read (HTTP ${res.status}); refusing`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Refusal(`no single club answers to ${key}; refusing`);
  const row = rows[0];
  if (REAL_CLUBS.has(row.id))
    throw new Refusal(`${row.name} is a real club; the walk never plays there`);
  if (!Array.isArray(row.tags) || !row.tags.includes(TEST_CLUB_TAG)) {
    throw new Refusal(
      `${row.name} is not flagged as a test club (clubs.tags has no ${TEST_CLUB_TAG})`
    );
  }
  if (row.asset !== 'chips')
    throw new Refusal(`${row.name} does not play in chips; the walk plays chip tables only`);
  if (row.lifecycle_status === 'retired') throw new Refusal(`${row.name} is retired`);
  return row;
}
