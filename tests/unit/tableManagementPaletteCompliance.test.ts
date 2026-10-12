import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/pages/GameManagementPage.module.css'), 'utf8');

const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 's'))?.[0] ?? '';
};

describe('Table Management uses the Club Arena Console status palette', () => {
  it('uses the approved positive and warning inks', () => {
    expect(rule('.healthGood')).toContain('color: #c8ffd2');
    expect(rule('.healthWarn,\n.healthAlert')).toContain('color: #ffd700');
    expect(rule('.statusRail.live')).toContain('background: #35d95a');
    expect(rule('.statusRail.live')).toContain('rgb(53 217 90 / 72%)');
    expect(rule('.ready')).toContain('color: #c8ffd2');
  });

  it('uses the approved refusal ink for every destructive state', () => {
    expect(rule('.locked,\n.blocked,\n.commandRejected')).toContain('color: #ff5b6e');
    expect(rule('.rowActions .danger')).toContain('color: #ff5b6e');
    expect(rule('.dialogError')).toContain('color: #ff5b6e');
  });

  it('does not restore the off-palette legacy status colors', () => {
    for (const legacy of ['#73e093', '#ffb94a', '#33d268', '#ff7282', '#78e09a']) {
      expect(css).not.toContain(legacy);
    }
  });
});
