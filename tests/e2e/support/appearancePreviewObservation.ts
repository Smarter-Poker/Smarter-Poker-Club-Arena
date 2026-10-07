import type { Locator } from '@playwright/test';

/** A missing preview must return an explicit zero-root sample, not wait inside the poll. */
export function readAppearanceRoots(previews: Locator) {
  return previews.evaluateAll((targets) =>
    targets.map((target) => ({
      table: target.getAttribute('data-table-theme') || '',
      background: target.getAttribute('data-background-theme') || '',
      button: target.getAttribute('data-button-theme') || '',
      cards: target.getAttribute('data-card-back') || '',
    }))
  );
}
