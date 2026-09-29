/**
 * THE GAME TYPE SELECTOR'S BACK CONTROL SAYS WHERE IT GOES
 * (Create A Club phase 2, 2026-09-22)
 *
 * It was a bare "‹‹" font glyph with no accessible name, so a screen reader
 * announced "button" and nothing else, and the console standard forbids a
 * generic glyph standing in for a control. It is the printed word Back now,
 * with a name that says where Back goes: the club page on the standalone
 * route, Table Management inside that console's creator deck.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CreateTablePage from '../src/pages/CreateTablePage';

afterEach(cleanup);

describe('the create-table back control', () => {
  it('on the standalone route it is "Back To The Club" and it goes to the club page', () => {
    render(
      <MemoryRouter initialEntries={['/clubs/c1/create-table']}>
        <Routes>
          <Route path="/clubs/:clubId/create-table" element={<CreateTablePage />} />
          <Route path="/clubs/:clubId" element={<p>Club Home Page</p>} />
        </Routes>
      </MemoryRouter>
    );
    const back = screen.getByRole('button', { name: 'Back To The Club' });
    // The visible word is the start of the name (voice control targets it).
    expect(back.textContent?.trim()).toBe('Back');
    expect(back.textContent).not.toMatch(/[‹›«»]/);
    fireEvent.click(back);
    expect(screen.getByText('Club Home Page')).toBeTruthy();
  });

  it('inside Table Management it is "Back To Table Management" and it hands control back', () => {
    const onBack = vi.fn();
    render(
      <MemoryRouter initialEntries={['/clubs/c1/games']}>
        <CreateTablePage clubIdOverride="c1" onBack={onBack} onSelectGameType={() => {}} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('button', { name: 'Back To The Club' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back To Table Management' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
