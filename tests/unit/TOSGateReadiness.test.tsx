import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: 'accepted' as 'accepted' | 'not_accepted' | 'unknown',
  getTOSStatus: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'certification-user' }, isHydrating: false }),
}));

vi.mock('../../src/services/ProfileService', () => ({
  profileService: { getTOSStatus: mocks.getTOSStatus },
}));

vi.mock('../../src/components/legal/TOSAcceptanceModal', () => ({
  default: () => <div data-testid="terms-modal">Terms Must Be Accepted</div>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/uuid', () => ({ uuid: () => 'idempotency-key' }));

import TOSGuard from '../../src/components/legal/TOSGuard';

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <TOSGuard>
        <div data-testid="protected-app">Protected App</div>
      </TOSGuard>
    </MemoryRouter>
  );
}

describe('Terms gate readiness is published by the gate that owns it', () => {
  beforeEach(() => {
    mocks.status = 'accepted';
    mocks.getTOSStatus.mockReset();
    mocks.getTOSStatus.mockImplementation(async () => mocks.status);
  });

  it('publishes accepted only after the canonical status read answers', async () => {
    renderGuard();

    await waitFor(() =>
      expect(document.querySelector('[data-tos-gate-status="accepted"]')).not.toBeNull()
    );
    expect(screen.getByTestId('protected-app')).toBeTruthy();
    expect(screen.queryByTestId('terms-modal')).toBeNull();
    expect(mocks.getTOSStatus).toHaveBeenCalledWith('certification-user');
  });

  it('publishes not_accepted while the outer gate replaces the protected app', async () => {
    mocks.status = 'not_accepted';
    renderGuard();

    await waitFor(() =>
      expect(document.querySelector('[data-tos-gate-status="not_accepted"]')).not.toBeNull()
    );
    expect(await screen.findByTestId('terms-modal')).toBeTruthy();
    expect(screen.queryByTestId('protected-app')).toBeNull();
  });

  it('publishes an unavailable decision without calling it accepted', async () => {
    mocks.status = 'unknown';
    renderGuard();

    await waitFor(() =>
      expect(document.querySelector('[data-tos-gate-status="unknown"]')).not.toBeNull()
    );
    expect(screen.getByTestId('protected-app')).toBeTruthy();
    expect(document.querySelector('[data-tos-gate-status="accepted"]')).toBeNull();
  });
});
