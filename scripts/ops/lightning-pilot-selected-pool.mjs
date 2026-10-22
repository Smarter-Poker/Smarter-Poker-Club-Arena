const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poolTab = (page, pin) => {
  if (!UUID.test(pin?.poolSessionId)) throw new Error('Explicit Pool Tab Required');
  return page.locator(`[data-tabid="${pin.poolSessionId}"]`);
};
/** A document route does not prove which restored game is active. Select normally. */
export async function selectPoolTab(page, pin, remaining, progress, { input = 'click' } = {}) {
  if (!['tap', 'click'].includes(input)) throw new Error('Pool Tab Input Unknown');
  const tab = poolTab(page, pin);
  progress.step = 'wait_for_pool_tab';
  await tab.waitFor({ state: 'visible', timeout: Math.min(15000, remaining()) });
  progress.step = 'find_existing_pool_tab';
  progress.matches = Math.min(2, await tab.count());
  if (progress.matches !== 1) throw new Error('Manual Pool Tab Missing Or Ambiguous');
  progress.visible = await tab.isVisible();
  if (!progress.visible) {
    progress.step = 'existing_pool_tab_hidden';
    throw new Error('Manual Pool Tab Hidden');
  }
  progress.step = 'select_existing_pool_tab';
  // A tap needs a touch context (Playwright refuses it otherwise): only a
  // witness that built its context with hasTouch passes input 'tap'; every
  // other witness selects with the ordinary click of the same control.
  progress.input = input;
  await tab[input]({ timeout: Math.min(5000, remaining()) });
  progress.step = 'verify_pool_selection';
  progress.selected = (await tab.getAttribute('aria-current', { timeout: remaining() })) === 'true';
  if (!progress.selected) throw new Error('Manual Selection');
}

/** Observe immediately before a gesture. A changed selection refuses without switching it back. */
export async function assertSelectedPoolTab(page, pin, remaining, progress = {}) {
  const tab = poolTab(page, pin);
  progress.step = 'assert_selected_pool';
  progress.matches = Math.min(2, await tab.count());
  if (progress.matches !== 1) throw new Error('Selected Pool Tab Missing Or Ambiguous');
  progress.visible = await tab.isVisible();
  progress.selected =
    (await tab.getAttribute('aria-current', { timeout: Math.min(5000, remaining()) })) === 'true';
  if (!progress.visible || !progress.selected) throw new Error('Selected Pool Unverified');
}

/** Preserve the normal control and request; selection is checked before its gesture. */
export async function clickSelectedPoolControl(page, pin, control, remaining, options = {}) {
  await assertSelectedPoolTab(page, pin, remaining);
  return control.click({
    ...options,
    timeout: Math.min(options.timeout ?? remaining(), remaining()),
  });
}
