import assert from 'node:assert/strict';

/** Actual NLH ActionPanel input, shared by isolated browser scenarios.
 * Opening a sizing panel is not a submitted game action. No API, page-state
 * mutation, preaction button, or acceptance verdict is supplied here.
 */
export async function submitLegalAllInThroughUI({ page, isCurrentTurn, timeout = 3000 }) {
  assert.equal(typeof isCurrentTurn, 'function');
  assert.ok(Number.isFinite(timeout) && timeout > 0);
  const ready = async (selector) => {
    const control = page.locator(`.action-panel ${selector}`);
    return (await control.isVisible()) && (await control.isEnabled());
  };
  const click = async (selector) => {
    if (!(await ready(selector)) || !(await isCurrentTurn())) return false;
    await page.locator(`.action-panel ${selector}`).click({ timeout });
    return true;
  };
  if (await click('.action-btn--allin')) return true;
  // A prior interrupted UI step may already have opened this same panel.
  if (await click('.raise-preset--allin')) return true;
  if (await click('.action-btn--raise')) {
    if (await click('.raise-preset--allin')) return true;
    // A visible but disabled shove is not legal. Close only this UI overlay
    // before trying an ordinary enabled Call/Check in the same current turn.
    await click('.raise-cancel');
  }
  return (await click('.action-btn--call')) || (await click('.action-btn--check'));
}
