// Sweep ALL live seats for the test account. Thin wrapper around the shared
// dock-following teardown in lib/leave-all.mjs — the same code the multi-table
// walk uses, so there is exactly one working implementation of "stand up from
// everything". Run it after any walk that dies mid-flight: a stranded seat
// blocks the 4-table cap for the test account and skews every later run.
//
//   node e2e-live/cleanup-seats.mjs
//
// Verifies through the UI only; for the final word check the database:
//   select count(*) from table_seats where user_id = <hero> and left_at is null;
//
// Standing up cashes a stack out, so this runs as the walk's test identity
// only (an address ending in .invalid; lib/test-only.mjs). Any other account,
// named or found in the saved browser state or in the page, is refused
// before a seat is touched.
import { chromium } from 'playwright';
import fs from 'fs';
import { leaveAllSeats } from './lib/leave-all.mjs';
import { Refusal, requirePageIdentity, requireTestIdentity } from './lib/test-only.mjs';

const AUTH = process.env.E2E_AUTH || '/tmp/e2e-work/auth.json';
let IDENTITY;
try {
  IDENTITY = requireTestIdentity({ authPath: AUTH });
} catch (e) {
  if (e instanceof Refusal) {
    console.log(`REFUSED: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(fs.existsSync(AUTH) ? { storageState: AUTH } : {}),
});
const page = await ctx.newPage();

await page.goto('https://smarter.poker/hub/club-arena/', { waitUntil: 'domcontentloaded', timeout: 45000 });
try {
  await requirePageIdentity(page, IDENTITY);
} catch (e) {
  console.log(`REFUSED: ${e.message}`);
  await browser.close();
  process.exit(2);
}

const left = await leaveAllSeats(page, { rounds: 8 });
console.log(`CLEANUP DONE -- tables left this run: ${left}`);

await ctx.storageState({ path: AUTH }).catch(() => {});
await browser.close();
