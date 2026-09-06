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

  it('keeps snapshot search controls large enough to tap without iOS zoom', () => {
    expect(rule('.toolSearch input')).toMatch(/min-height:\s*44px/);
    expect(rule('.toolSearch input')).toMatch(/font-size:\s*16px/);
    expect(rule('.toolSort select')).toMatch(/min-height:\s*44px/);
  });
});
