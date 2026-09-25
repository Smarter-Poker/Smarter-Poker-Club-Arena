import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(__dirname, '../../src/components/club/RakeSnapshotPanel.module.css'),
  'utf8'
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} rule is missing`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Club Data touch targets', () => {
  it('keeps the snapshot period and export controls at the 44px phone minimum', () => {
    const shared = css.match(/\.scope,\s*\.period,\s*\.exportBtn\s*\{([^}]*)\}/);
    expect(shared).not.toBeNull();
    expect(shared?.[1]).toMatch(/min-height:\s*44px/);
  });

  it.each(['.drill', '.crumbs button', '.pagerBtn', '.toolClear', '.drillIn'])(
    'keeps %s touch-safe in every rendered state',
    (selector) => {
      expect(rule(selector)).toMatch(/min-height:\s*44px/);
    }
  );

  /**
   * 2026-09-22: the floor is two axes, and only one of them was declared.
   * `club-data-deep.spec.ts:150` measured the live page at 390px and returned
   * DAY 32.7 wide, WEEK 42.1 and YEAR 41.1 - all 44 tall, all under the floor
   * across, because the width came from padding around three or four
   * condensed characters. `.drill` and `.drillIn` are excluded on purpose:
   * they declare `min-width: 0` because they take their width from the row
   * they sit in.
   */
  it.each(['.scope,\n.period,\n.exportBtn', '.crumbs button', '.pagerBtn', '.toolClear'])(
    'keeps %s on the touch floor across as well as down',
    (selector) => {
      const body = selector.includes(',')
        ? (css.match(/\.scope,\s*\.period,\s*\.exportBtn\s*\{([^}]*)\}/) ?? [])[1]
        : rule(selector);
      expect(body, `${selector} is missing its width floor`).toMatch(/min-width:\s*44px/);
      expect(body, `${selector} is missing its height floor`).toMatch(/min-height:\s*44px/);
    }
  );

  it('keeps snapshot search controls large enough to tap without iOS zoom', () => {
    expect(rule('.toolSearch input')).toMatch(/min-height:\s*44px/);
    expect(rule('.toolSearch input')).toMatch(/font-size:\s*16px/);
    expect(rule('.toolSort select')).toMatch(/min-height:\s*44px/);
  });
});
