import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const UNION_A = '11111111-1111-4111-8111-111111111111';
const UNION_B = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  sync: new Map<string, string>(),
  pending: new Map<string, { promise: Promise<string>; resolve: (value: string) => void }>(),
}));

vi.mock('../../src/utils/unionIdResolver', () => ({
  resolveUnionUUIDSync: (ref: string) => mocks.sync.get(ref) ?? null,
  resolveUnionUUID: (ref: string) => {
    const pending = mocks.pending.get(ref);
    if (!pending) throw new Error(`Missing resolver for ${ref}`);
    return pending.promise;
  },
}));

import { useUnionRouteId } from '../../src/hooks/useUnionRouteId';

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness() {
  const navigate = useNavigate();
  const { unionId, unionRef } = useUnionRouteId();
  return (
    <>
      <output aria-label="resolved union">{`${unionRef}:${unionId ?? 'pending'}`}</output>
      <button type="button" onClick={() => navigate('/unions/bravo')}>
        Open Bravo
      </button>
    </>
  );
}

describe('useUnionRouteId route scoping', () => {
  beforeEach(() => {
    mocks.sync.clear();
    mocks.pending.clear();
  });

  it('never returns the previous slug UUID while the next slug is resolving', async () => {
    mocks.sync.set('alpha', UNION_A);
    const bravo = deferred();
    mocks.pending.set('bravo', bravo);

    render(
      <MemoryRouter initialEntries={['/unions/alpha']}>
        <Routes>
          <Route path="/unions/:unionId" element={<Harness />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByLabelText('resolved union')).toHaveTextContent(`alpha:${UNION_A}`);
    fireEvent.click(screen.getByRole('button', { name: 'Open Bravo' }));
    expect(screen.getByLabelText('resolved union')).toHaveTextContent('bravo:pending');

    await act(async () => {
      bravo.resolve(UNION_B);
      await bravo.promise;
    });

    expect(screen.getByLabelText('resolved union')).toHaveTextContent(`bravo:${UNION_B}`);
  });
});
