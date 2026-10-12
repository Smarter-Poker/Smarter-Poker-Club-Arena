import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { exportHandHistoryPDF, exportSettlementPDF } from '../src/lib/export';
import { arenaDisplayText } from '../src/lib/arenaDisplay/text';
import { formatGameTitle } from '../src/utils/formatGameTitle';
import { formatPopupText } from '../src/utils/popupStyle';
import { titleCase } from '../src/utils/titleCase';
import { createElement } from '../src/lib/arenaDisplay';
import { jsx } from '../src/lib/arenaDisplay/jsx-runtime';
import { jsxDEV } from '../src/lib/arenaDisplay/jsx-dev-runtime';

describe('dollar signs never reach arena display copy', () => {
  it('cleans both reported satellite names without changing amounts', () => {
    expect(formatGameTitle('Sunday Deep Stack Satellite $2')).toBe('Sunday Deep Stack Satellite 2');
    expect(formatGameTitle('Sunday Deep Stack Satellite $5')).toBe('Sunday Deep Stack Satellite 5');
    expect(arenaDisplayText('$1,250.50 / ＄5 / ﹩2')).toBe('1,250.50 / 5 / 2');
    expect(arenaDisplayText('\u{1F4B2}5 / \u{1F4B0}$25 / \u{1F4B5}54')).toBe('5 / 25 / 54');
    expect(titleCase('win $25')).toBe('Win 25');
    expect(formatPopupText('paid you $49.95')).toBe('Paid You 49.95');
  });

  it('renders dynamic children, nested arrays, portals destination copy and accessible labels without dollars', () => {
    const name = 'Sunday Deep Stack Satellite $5';
    const html = renderToStaticMarkup(
      <section title={name} aria-label={`Open ${name}`}>
        <h2>{name}</h2>
        <span>{['$5', [' / ', '$54']]}</span>
        <img alt="$25 Prize" src="/prize.png" />
        <input placeholder="$5" defaultValue="$25" />
        <textarea defaultValue="$54" />
        <select defaultValue="$id">
          <option value="$id">$25 Tournament</option>
        </select>
      </section>
    );
    expect(html).toContain('Sunday Deep Stack Satellite 5');
    expect(html).toContain('value="$id"');
    expect(html.replace('value="$id"', '')).not.toContain('$');
    expect(name).toContain('$5');
  });

  it('normalizes standalone worker notifications before display, preserving event identity', async () => {
    const handlers: Array<(event: unknown) => void> = [];
    const displayed: Array<{ title: string; options: { body: string; tag: string } }> = [];
    const self = {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === 'message') handlers.push(handler);
      },
      clients: { matchAll: async () => [] },
      registration: {
        showNotification: (title: string, options: { body: string; tag: string }) =>
          displayed.push({ title, options }),
      },
    };
    runInNewContext(readFileSync('public/sw-bus.js', 'utf8'), { self });
    const event = {
      data: {
        type: 'BUS_EVENT',
        event: { type: 'CLUB_JOINED', payload: { clubName: 'Satellite $5' } },
      },
    };
    handlers.forEach((handler) => handler(event));
    await Promise.resolve();
    await Promise.resolve();
    expect(displayed).toHaveLength(1);
    expect(displayed[0].options.body).toBe('Satellite 5');
    expect(displayed[0].options.tag).toBe('bus-CLUB_JOINED');
    expect(event.data.event.payload.clubName).toBe('Satellite $5');
  });

  it('renders printable hand and settlement previews without changing original names or amounts', async () => {
    vi.useFakeTimers();
    const frames: HTMLIFrameElement[] = [];
    try {
      const hand = {
        handId: '$hand',
        tableName: 'Satellite $5 &#36;25',
        stakes: '$2/$5',
        date: 'Today',
        players: [{ name: 'Player $25', position: 'BTN', stack: 54 }],
        actions: [{ player: 'Player $25', action: 'Bet', amount: 5, street: 'Flop' }],
        result: { winners: ['Player $25'], pot: 54 },
        communityCards: ['As'],
      };
      const handResult = exportHandHistoryPDF(hand);
      let frame = document.querySelector('iframe')!;
      frames.push(frame);
      expect(frame.contentDocument!.body.textContent).not.toContain('$');
      expect(frame.contentDocument!.body.textContent).toContain('Satellite 5 &#36;25');
      expect(frame.contentDocument!.body.textContent).toContain('wins 54');
      Object.defineProperty(frame.contentWindow!, 'print', { value: vi.fn(), configurable: true });
      await vi.advanceTimersByTimeAsync(500);
      await handResult;
      expect(hand.handId).toBe('$hand');
      expect(hand.stakes).toBe('$2/$5');
      expect(hand.result.pot).toBe(54);
      const settlement = {
        periodNumber: 1,
        year: 2026,
        startDate: 'Today',
        endDate: 'Today',
        totalRake: 25,
        totalBBJ: 2,
        clubWires: [
          {
            clubName: 'Club $5',
            netPlayerPL: 54,
            grossRake: 25,
            unionTax: 2,
            agentCommissions: 5,
            finalWire: 54,
            direction: 'PAY_TO_UNION',
          },
        ],
        agentPayouts: [
          {
            agentName: 'Agent $25',
            rakeGenerated: 25,
            commissionRate: 0.2,
            grossCommission: 5,
            netPayout: 5,
          },
        ],
      };
      const settlementResult = exportSettlementPDF(settlement);
      frame = document.querySelector('iframe')!;
      frames.push(frame);
      expect(frame.contentDocument!.body.textContent).not.toContain('$');
      expect(frame.contentDocument!.body.textContent).toContain('Club 5');
      expect(frame.contentDocument!.body.textContent).toContain('Agent 25');
      Object.defineProperty(frame.contentWindow!, 'print', { value: vi.fn(), configurable: true });
      await vi.advanceTimersByTimeAsync(500);
      await settlementResult;
      expect(settlement.clubWires[0].clubName).toBe('Club $5');
      expect(settlement.clubWires[0].finalWire).toBe(54);
      expect(document.querySelector('iframe')).toBeNull();
    } finally {
      frames.forEach((frame) => frame.remove());
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('keeps machine identifiers, passwords, callbacks and component model data intact', () => {
    const onClick = () => {};
    const node = jsx('a', { href: '/clubs/$id', id: '$id', onClick, children: '$25' });
    expect(node.props).toMatchObject({ href: '/clubs/$id', id: '$id', onClick, children: '25' });
    const password = jsx('input', { type: 'password', value: '$secret' });
    expect(password.props.value).toBe('$secret');
    const model = { name: '$5', balance: 54 };
    const Component = () => null;
    expect(jsx(Component, { model }).props.model).toBe(model);
  });

  it('retains the existing no-decoration source guard while removing dollar-bearing pictograms', () => {
    expect(
      execFileSync(process.execPath, ['scripts/ci/check-no-emoji.mjs'], {
        encoding: 'utf8',
      })
    ).toContain('OK - no emoji in player-facing code');
  });

  it('registers the generated runtime imports without raising the orphan baseline', () => {
    const report = JSON.parse(
      execFileSync(process.execPath, ['scripts/ci/report-orphan-modules.mjs', '--json'], {
        encoding: 'utf8',
      })
    );
    expect(report.orphans.length).toBeLessThanOrEqual(report.baseline);
    expect(report.orphans).not.toContain('src/lib/arenaDisplay/jsx-runtime.ts');
    expect(report.orphans).not.toContain('src/lib/arenaDisplay/jsx-dev-runtime.ts');
    const entry = JSON.parse(
      readFileSync('scripts/ci/entry-chunk.d/fix-arena-no-dollar-20261009.json', 'utf8')
    );
    expect(entry.modules).toEqual([
      'src/lib/arenaDisplay/jsx-runtime.ts',
      'src/lib/arenaDisplay/text.ts',
    ]);
    expect(entry._owner).toContain('before first paint');
    const config = readFileSync('vite.config.ts', 'utf8');
    for (const file of ['jsx-runtime.ts', 'jsx-dev-runtime.ts'])
      expect(config).toContain(`./src/lib/arenaDisplay/${file}`);
  });

  it('applies the same rule in the production and development runtime', () => {
    expect(createElement('span', { title: '$5' }, '$25').props).toMatchObject({
      title: '5',
      children: '25',
    });
    expect(jsx('span', { children: '$5' }).props.children).toBe('5');
    expect(
      jsxDEV('span', { children: '$5' }, undefined, false, undefined, undefined).props.children
    ).toBe('5');
    for (const config of ['vite.config.ts', 'vite.prerender.config.ts', 'vitest.config.ts']) {
      expect(readFileSync(config, 'utf8')).toContain("jsxImportSource: '@arena-display'");
    }
    expect(
      JSON.parse(readFileSync('tsconfig.app.json', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
        .compilerOptions.jsxImportSource
    ).toBe('@arena-display');
    for (const source of [
      'src/components/tournament/rankingShareImage.ts',
      'src/components/stats/StatsShareCard.tsx',
      'src/components/games/sceneKit.ts',
    ]) {
      expect(readFileSync(source, 'utf8')).toContain('arenaDisplayText(');
    }
    expect(readFileSync('src/components/table/ThrowableSignatures.css', 'utf8')).not.toContain(
      "content: '$'"
    );
    expect(readFileSync('src/components/table/BBJCelebration.tsx', 'utf8')).not.toContain(
      "fillText('$'"
    );
  });
});
