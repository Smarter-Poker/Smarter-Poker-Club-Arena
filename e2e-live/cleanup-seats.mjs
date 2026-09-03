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
import { chromium } from 'playwright';
import fs from 'fs';
import { leaveAllSeats } from './lib/leave-all.mjs';

const AUTH = process.env.E2E_AUTH || '/tmp/e2e-work/auth.json';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(fs.existsSync(AUTH) ? { storageState: AUTH } : {}),
});
const page = await ctx.newPage();

const left = await leaveAllSeats(page, { rounds: 8 });
console.log(`CLEANUP DONE -- tables left this run: ${left}`);

await ctx.storageState({ path: AUTH }).catch(() => {});
await browser.close();
