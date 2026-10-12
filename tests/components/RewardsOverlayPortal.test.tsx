import { createContext, useContext } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RewardsOverlayPortal from '../../src/components/rewards/RewardsOverlayPortal';

afterEach(cleanup);

describe('Rewards overlay mounting', () => {
  it('escapes an isolated page while retaining its account context', () => {
    const Account = createContext('wrong-account');
    function Dialog() {
      return <div role="dialog">{useContext(Account)}</div>;
    }
    const view = render(
      <Account.Provider value="current-account">
        <main style={{ isolation: 'isolate', position: 'relative' }}>
          <RewardsOverlayPortal>
            <Dialog />
          </RewardsOverlayPortal>
        </main>
      </Account.Provider>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('current-account');
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    view.unmount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
