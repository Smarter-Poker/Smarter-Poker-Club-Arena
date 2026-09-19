import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});
it('holds links, push, replace, back and unload until the actual bonus finishes', () => {
  const blocked = vi.fn();
  function Game() {
    const [active, setActive] = useState(true);
    const navigate = useNavigate();
    useLiveBonusGuard(active, blocked);
    return (
      <>
        <h1>Live Bonus</h1>
        <a href="/elsewhere">Leave Link</a>
        <button onClick={() => navigate('/elsewhere')}>Leave</button>
        <button onClick={() => navigate('/elsewhere', { replace: true })}>Replace</button>
        <button onClick={() => navigate(-1)}>Back</button>
        <button onClick={() => setActive(false)}>Finish</button>
      </>
    );
  }
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Game />} />
        <Route path="/elsewhere" element={<h1>Wheel</h1>} />
      </Routes>
    </BrowserRouter>
  );
  for (const label of ['Leave', 'Replace', 'Back'])
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  fireEvent.click(screen.getByRole('link', { name: 'Leave Link' }));
  expect(blocked).toHaveBeenCalledTimes(4);
  expect(screen.getByText('Live Bonus')).toBeTruthy();
  const before = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(true);
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  window.history.replaceState({ idx: -1 }, '', '/elsewhere');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(go).toHaveBeenCalledWith(1);
  expect(screen.getByText('Live Bonus')).toBeTruthy();
  window.history.replaceState({ idx: 0 }, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Leave', exact: true }));
  expect(screen.getByText('Wheel')).toBeTruthy();
});
