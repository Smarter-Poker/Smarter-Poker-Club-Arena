import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openLobbyGameSection } from '../e2e/support/lobbyGameSections';

describe('the actual production Lightning entry readiness sequence', () => {
  it('opens the initially closed Cash Games section before waiting for visible rows', async () => {
    const source = readFileSync('tests/e2e/production-lightning-lobby-join.spec.ts', 'utf8');
    const start = source.indexOf('    await page.goto(');
    const end = source.indexOf('    await settleDiamondSpinsOffer(page, offer);', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let cashOpen = false;
    const actions: string[] = [];
    const page = {
      goto: async () => {
        cashOpen = false;
        actions.push('navigate');
      },
      getByRole: (_role: string, { name }: { name: string }) => ({
        waitFor: async () => {
          expect(name).toBe('Cash Games');
        },
        getAttribute: async () => String(cashOpen),
        click: async () => {
          cashOpen = true;
          actions.push('open-cash');
        },
      }),
      locator: () => ({ first: () => ({ visibleRows: true }) }),
    };
    const assertion = (subject: unknown) => ({
      not: { toHaveURL: async () => {} },
      toBeVisible: async () => {
        expect(subject).toEqual({ visibleRows: true });
        if (!cashOpen)
          throw new Error('The real readiness wait cannot see rows in the closed section');
        actions.push('rows-visible');
      },
    });
    const run = new Function(
      'page',
      'club',
      'expect',
      'prepareCashLobbyActions',
      'openLobbyGameSection',
      `return (async () => { ${source.slice(start, end)} })();`
    );
    await run(page, 'fixture', assertion, async () => {}, openLobbyGameSection);
    expect(actions).toEqual(['navigate', 'open-cash', 'rows-visible']);
  });
});
