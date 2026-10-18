import type { Locator } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { readFinancialTouchControls } from '../e2e/helpers/financial-touch-controls';

function mount(markup: string) {
  const root = document.createElement('main');
  document.body.append(root);
  const render = () => {
    root.innerHTML = markup;
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (!el.style.visibility) el.style.visibility = 'visible';
      el.getBoundingClientRect = () => {
        if (!el.isConnected || getComputedStyle(el).display === 'none') return new DOMRect();
        return new DOMRect(0, 0, Number(el.dataset.width ?? 44), Number(el.dataset.height ?? 44));
      };
      // happy-dom has no layout engine; actual browser visibility is qualified separately.
      el.checkVisibility = () => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
    }
  };
  render();
  let replaceBeforeMeasure = false;
  const locator = {
    evaluate: async (fn: (root: Element) => unknown) => {
      if (replaceBeforeMeasure) render();
      return fn(root);
    },
    locator: (selector: string) => ({
      evaluateAll: async (fn: (controls: Element[]) => unknown) => {
        const selected = Array.from(
          root.querySelectorAll(selector.replace(/:visible/g, ''))
        ).filter(
          (el) =>
            getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'
        );
        if (replaceBeforeMeasure) {
          render();
          replaceBeforeMeasure = false;
        }
        return fn(selected);
      },
    }),
  } as unknown as Locator;
  return {
    root,
    locator,
    replaceBetweenSelectionAndMeasurement: () => {
      replaceBeforeMeasure = true;
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Financial Admin atomic control measurement', () => {
  it('measures current controls when a dashboard replaces previously selected nodes', async () => {
    const fixture = mount(
      '<button>Open Club Bank Cashier</button><button>Open Agent Management</button><button>Open Disputes</button>'
    );
    fixture.replaceBetweenSelectionAndMeasurement();
    expect(await readFinancialTouchControls(fixture.locator)).toEqual({
      undersized: [],
      undersizedTextInputs: [],
    });
  });

  it('still reports a connected visible control below 44px', async () => {
    const fixture = mount('<button data-width="43" data-height="44">Small</button>');
    expect((await readFinancialTouchControls(fixture.locator)).undersized).toEqual([
      { label: 'Small', width: 43, height: 44 },
    ]);
  });

  it('still reports visible text fields below 16px, preserving the exact boundary', async () => {
    const fixture = mount(
      '<input aria-label="Too Small" style="font-size:15px"><select aria-label="Boundary" style="font-size:16px"></select><textarea aria-label="Small Note" style="font-size:14px"></textarea><input type="checkbox" style="font-size:10px">'
    );
    expect((await readFinancialTouchControls(fixture.locator)).undersizedTextInputs).toEqual([
      { label: 'Too Small', fontSize: 15 },
      { label: 'Small Note', fontSize: 14 },
    ]);
  });

  it('excludes display-none and visibility-hidden controls', async () => {
    const fixture = mount(
      '<button style="display:none" data-width="1">Hidden</button><input style="visibility:hidden;font-size:10px" aria-label="Hidden Input"><button>Ready</button>'
    );
    expect(await readFinancialTouchControls(fixture.locator)).toEqual({
      undersized: [],
      undersizedTextInputs: [],
    });
  });

  it('does not excuse visible display-contents controls whose own target has no box', async () => {
    const fixture = mount(
      '<div role="button" style="display:contents" data-width="0" data-height="0"><span>Visible Child</span></div>'
    );
    expect((await readFinancialTouchControls(fixture.locator)).undersized).toEqual([
      { label: 'Visible Child', width: 0, height: 0 },
    ]);
  });
});
