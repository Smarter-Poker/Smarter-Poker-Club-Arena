import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
