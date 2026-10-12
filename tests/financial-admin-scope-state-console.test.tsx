import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialAdminScope } from '../src/hooks/useFinancialAdminScope';

vi.mock('../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    family,
    foot,
    plates,
    title,
    children,
  }: {
    family?: string;
    foot?: string;
    plates?: { primary?: unknown; secondary?: unknown };
    title: string;
    children?: React.ReactNode;
  }) => (
    <section
      aria-label={title}
      data-family={family}
      data-foot={foot}
      data-plates={Number(Boolean(plates?.primary)) + Number(Boolean(plates?.secondary))}
    >
      {children}
    </section>
  ),
}));

import FinancialAdminScopeState from '../src/components/common/FinancialAdminScopeState';

function scope(status: FinancialAdminScope['status']): FinancialAdminScope {
  return {
    status,
    clubId: null,
    platformWide: false,
    clubRole: null,
    isPlatformStaff: false,
    userId: null,
    message: null,
    reload: vi.fn(),
  };
}

describe('Financial Admin scope-state Console artwork', () => {
  it.each([
    ['loading', 'spade', 'foot', '0'],
    ['denied', 'shark', 'plates', '1'],
    ['error', 'riveted', 'plates', '2'],
  ] as const)(
    '%s fills exactly the plates painted by its approved master',
    (status, family, foot, plates) => {
      render(
        <MemoryRouter>
          <FinancialAdminScopeState scope={scope(status)} />
        </MemoryRouter>
      );

      const console = screen.getByRole('region');
      expect(console).toHaveAttribute('data-family', family);
      expect(console).toHaveAttribute('data-foot', foot);
      expect(console).toHaveAttribute('data-plates', plates);
    }
  );
});
