/**
 * Leave every live seat for the signed-in account, by FOLLOWING THE DOCK.
 *
 * Why the dock and not the tab bar: the tab bar only lists tables this page
 * instance happens to have mounted, so a walk that navigated around can miss
 * seats it opened earlier. The LiveTablesBar dock is rebuilt from server truth
 * (table_seats where left_at IS NULL) on every arrival at the arena route, so
 * it is the honest list of "what am I still sitting at". Loop until it stops
 * appearing.
 *
 * Shared by multitable-walk.mjs and cleanup-seats.mjs — a stranded seat blocks
 * the 4-table cap for the test account and skews every later run, so both need
 * exactly the same, working teardown rather than two half-copies of it.
 */
const ARENA = 'https://smarter.poker/hub/club-arena/';

async function leaveActiveTable(page) {
  // The active table's HUD menu is the visible trigger in the upper-left
  // corner; other mounted tables render their own (hidden, zero-sized) copies.
  const handles = await page.locator('button[aria-label="Table menu"]').elementHandles();
  let menu = null;
  for (const h of handles) {
    const bb = await h.boundingBox();
    if (bb && bb.width > 0 && bb.x < 200 && bb.y < 120) { menu = h; break; }
  }
  if (!menu) return false;
  if (!(await menu.click({ timeout: 8000 }).then(() => true).catch(() => false))) return false;
  await page.waitForTimeout(1200);

  const leave = page.locator('text=Leave Table').first();
  if (!(await leave.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await page.waitForTimeout(1200);

  const confirm = page.locator('.leave-confirm__btn:not(.leave-confirm__btn--cancel)').last();
  if (!(await confirm.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await page.waitForTimeout(6000);
  return true;
}

export async function leaveAllSeats(page, { rounds = 8, log = console.log } = {}) {
  let left = 0;
  for (let round = 0; round < rounds; round++) {
    await page.goto(ARENA, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(8000);
    await page.keyboard.press('Escape').catch(() => {}); // stray nav drawer

    // The dock is rendered from server truth a beat after the page settles —
    // an instant isVisible() check races it and reports a clean session that
    // still has live seats. Wait for it.
    const dock = page.locator('text=/Return to game|Act now/i').first();
    if (!(await dock.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false))) {
      log(`  cleanup round ${round}: no dock after 15s — no live seats left`);
      break;
    }
    if (!(await dock.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
      log(`  cleanup round ${round}: dock visible but not clickable`);
      continue;
    }
    await page.waitForTimeout(6000);

    // The dock lands on one table; if we are only spectating there, step
    // through the other mounted tabs to find the one we actually sit at.
    for (let t = 0; t < 3; t++) {
      const footer = await page
        .locator('.action-panel-wrapper, [class*="spectator-footer"]').first()
        .innerText().catch(() => '');
      if (!/Spectating, Tap An Open Seat/i.test(footer)) break;
      const other = page
        .locator('[class*="table-tab-bar__tab"]:not([class*="--active"]):not(:has-text("Lobby"))')
        .first();
      if (!(await other.click({ timeout: 6000 }).then(() => true).catch(() => false))) break;
      await page.waitForTimeout(3000);
    }

    if (await leaveActiveTable(page)) {
      left++;
      log(`  cleanup round ${round}: left a table (total ${left})`);
    } else {
      log(`  cleanup round ${round}: could not leave from this tab`);
    }
  }
  return left;
}
