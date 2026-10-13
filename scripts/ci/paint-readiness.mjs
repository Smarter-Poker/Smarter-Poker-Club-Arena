/** Wait for the browser's paint signal, preserving missing paint as failure. */
export async function waitForFirstContentfulPaint(page, timeout = 5000) {
  await page.bringToFront();
  try {
    await page.waitForFunction(
      () => performance.getEntriesByName('first-contentful-paint').some((entry) => entry.startTime > 0),
      undefined,
      { timeout }
    );
    return true;
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    return false;
  }
}
