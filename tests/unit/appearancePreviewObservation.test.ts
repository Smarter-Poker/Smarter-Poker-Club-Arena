import { beforeEach, describe, expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import { readAppearanceRoots } from '../e2e/support/appearancePreviewObservation';

// The browser qualification separately exercises the real Locator in Chrome.
// Here real DOM attributes pin missing/duplicate roots and the exact projection.
const locator = {
  evaluateAll: async (project: (nodes: Element[]) => unknown) =>
    project([...document.querySelectorAll('.studio-game-preview')]),
} as unknown as Locator;

describe('appearance preview observation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('returns an explicit absent-root sample instead of awaiting attachment', async () => {
    expect(await readAppearanceRoots(locator)).toEqual([]);
  });
  it('keeps every root and exactly the painted appearance attributes', async () => {
    document.body.innerHTML =
      '<div class="studio-game-preview" data-table-theme="carbon_red" data-background-theme="midnight" data-button-theme="gray-d-gear" data-card-back="classic_red" data-private="not-retained"></div>';
    const projected = {
      table: 'carbon_red',
      background: 'midnight',
      button: 'gray-d-gear',
      cards: 'classic_red',
    };
    expect(await readAppearanceRoots(locator)).toEqual([projected]);
    document.body.append(document.body.firstElementChild!.cloneNode(true));
    expect(await readAppearanceRoots(locator)).toEqual([projected, projected]);
  });
});
