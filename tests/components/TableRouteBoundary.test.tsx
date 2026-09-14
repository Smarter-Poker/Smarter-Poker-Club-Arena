import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TableRouteBoundary } from '../../src/components/table/TableRouteBoundary';

const routeId = 'a1234567-89ab-cdef-0123-456789abcdef';
const embeddedId = 'b1234567-89ab-cdef-0123-456789abcdef';

function ActiveTable({ id, start, stop }: { id: string; start: () => void; stop: () => void }) {
  useEffect(() => {
    start();
    return stop;
  }, [id, start, stop]);
  return <div data-testid="active-table">{id}</div>;
}

function entry(path: string, start: () => void, stop: () => void, embeddedTableId?: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>Lobby Home</div>} />
        <Route
          path="/table/:tableId?"
          element={
            <TableRouteBoundary embeddedTableId={embeddedTableId}>
              {(id) => <ActiveTable id={id} start={start} stop={stop} />}
            </TableRouteBoundary>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('table entry boundary', () => {
  it.each(['demo', 'nonexistent-table-id', '12345', 'null', routeId + 'x', ''])(
    'rejects %s before live table effects start',
    (id) => {
      const start = vi.fn();
      render(entry('/table/' + id, start, vi.fn()));
      expect(screen.queryByTestId('active-table')).toBeNull();
      expect(start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Return To Lobby' }));
      expect(screen.getByText('Lobby Home')).toBeTruthy();
    }
  );

  it.each([routeId, routeId.toUpperCase()])('mounts the valid route %s', (id) => {
    const start = vi.fn();
    render(entry('/table/' + id, start, vi.fn()));
    expect(screen.getByTestId('active-table').textContent).toBe(id);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('validates the embedded table independently of a malformed outer route', () => {
    const start = vi.fn();
    render(entry('/table/demo', start, vi.fn(), embeddedId));
    expect(screen.getByTestId('active-table').textContent).toBe(embeddedId);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not replace an invalid embedded table with a valid outer table', () => {
    const start = vi.fn();
    render(entry('/table/' + routeId, start, vi.fn(), 'demo'));
    expect(screen.queryByTestId('active-table')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('unmounts active effects if an embedded entry becomes invalid and can recover', () => {
    const start = vi.fn();
    const stop = vi.fn();
    const page = render(entry('/table/' + routeId, start, stop, embeddedId));
    page.rerender(entry('/table/' + routeId, start, stop, 'demo'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('active-table')).toBeNull();
    page.rerender(entry('/table/' + routeId, start, stop, embeddedId));
    expect(screen.getByTestId('active-table').textContent).toBe(embeddedId);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
