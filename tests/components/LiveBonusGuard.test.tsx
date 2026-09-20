import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it('a release outlives the next render, ends when the hold is next armed, and restores to the re-anchored position', () => {
  const blocked = vi.fn();
  let release: () => void = () => {};
  function Game() {
    const [active, setActive] = useState(true);
    const [, rerender] = useState(0);
    const navigate = useNavigate();
    release = useLiveBonusGuard(active, blocked);
    return (
      <>
        <h1>Live Bonus</h1>
        <button onClick={() => navigate('/elsewhere')}>Leave</button>
        <button onClick={() => rerender((n) => n + 1)}>Render</button>
        <button onClick={() => setActive(false)}>Finish</button>
        <button onClick={() => setActive(true)}>Arm</button>
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
  // Released, then re-rendered: the hold must stay released.
  act(() => release());
  fireEvent.click(screen.getByRole('button', { name: 'Render', exact: true }));
  // Finished, moved between rounds, armed again: the release is spent and the
  // restore position is the new one.
  fireEvent.click(screen.getByRole('button', { name: 'Finish', exact: true }));
  window.history.replaceState({ idx: 4 }, '', '/');
  fireEvent.click(screen.getByRole('button', { name: 'Arm', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave', exact: true }));
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Live Bonus')).toBeTruthy();
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  window.history.replaceState({ idx: 3 }, '', '/elsewhere');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(go).toHaveBeenCalledWith(1);
  expect(blocked).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Live Bonus')).toBeTruthy();
  window.history.replaceState({ idx: 4 }, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
  // Released once more: navigation goes through, even after a render.
  act(() => release());
  fireEvent.click(screen.getByRole('button', { name: 'Render', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave', exact: true }));
  expect(blocked).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Wheel')).toBeTruthy();
});
