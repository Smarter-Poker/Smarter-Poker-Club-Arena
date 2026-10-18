import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import PageBar from '../../src/components/help/PageBar';
import PageHelp from '../../src/components/help/PageHelp';

afterEach(cleanup);

function renderAt(path: string, ui: React.ReactElement) {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
}

describe('the "?" explains the page and walks its tutorial from the bottom', () => {
  it('opens on the explanation, then steps through the tour and lights each target', () => {
    renderAt(
      '/somewhere',
      <main>
        <PageBar
          title="Hand Archive"
          summary="Every Hand You Played. Expand A Hand For The Full Rundown."
          steps={[{ title: 'Filters', body: 'Narrow The List.', target: '#filters' }]}
        />
        <div id="filters">Filters</div>
      </main>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Every Hand You Played.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Page Help' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('About This Page');
    expect(dialog.textContent).toContain('Hand Archive');
    expect(dialog.textContent).toContain('Every Hand You Played.');

    fireEvent.click(screen.getByRole('button', { name: 'Start Tutorial' }));
    expect(screen.getByRole('dialog').textContent).toContain('Narrow The List.');
    expect(document.getElementById('filters')?.hasAttribute('data-tutorial-focus')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog').textContent).toContain('You Are All Set');
    expect(document.getElementById('filters')?.hasAttribute('data-tutorial-focus')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('builds a tour from the page itself when none is written', () => {
    renderAt(
      '/somewhere',
      <main>
        <PageHelp title="Club Data" summary="Track Every Game. Read Every Fee." />
        <section>
          <h2>Rake By Game</h2>
          <p>Every Table Ranked By The Rake It Took This Period.</p>
        </section>
      </main>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Page Help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Tutorial' }));
    expect(screen.getByRole('dialog').textContent).toContain('Read Every Fee.');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog').textContent).toContain('Rake By Game');
    expect(screen.getByRole('dialog').textContent).toContain(
      'Every Table Ranked By The Rake It Took This Period.'
    );
  });

  it('uses the curated tour for a known route, and Escape closes it', () => {
    renderAt('/notifications', <PageHelp title="Notifications" summary="Your Signals." />);
    fireEvent.click(screen.getByRole('button', { name: 'Page Help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Tutorial' }));
    expect(screen.getByRole('dialog').textContent).toContain('All Or Unread');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders without a router (prerendered pages, isolated renders)', () => {
    render(<PageHelp title="Legal Center" summary="Platform Rules." />);
    expect(screen.getByRole('button', { name: 'Page Help' })).toBeTruthy();
  });
});

// The production 375px Players mode switch was behind the centered heading;
// Monthly Challenges also exceeded 320px at 200% text. Browser proof exercises
// those real components; keep the responsible layout boundary in normal CI.
describe('PageBar responsive heading and control rows', () => {
  it('preserves centered desktop titles and separates wrapping phone titles from controls', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/help/PageHelp.css'), 'utf8');
    const mobile = css.match(/@media \(max-width: 703px\) \{([\s\S]*?)\n\}/)?.[1];
    expect(mobile).toBeDefined();
    expect(css.slice(0, css.indexOf('@media (max-width: 703px)'))).toContain(
      'grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)'
    );
    expect(mobile).toMatch(
      /\.ca-page-bar__title\s*\{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 1;[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s
    );
    expect(mobile).toMatch(/\.ca-page-bar__live\s*\{[^}]*grid-column: 1;[^}]*grid-row: 2;/s);
    expect(mobile).toMatch(
      /\.ca-page-bar > \.ca-page-help\s*\{[^}]*grid-column: 2;[^}]*grid-row: 2;/s
    );
    expect(mobile).toMatch(/:not\(:has\(> \.ca-page-bar__title\)\)[\s\S]*grid-row: 1;/);
    expect(mobile).not.toMatch(/font-size|pointer-events/);
  });
});
