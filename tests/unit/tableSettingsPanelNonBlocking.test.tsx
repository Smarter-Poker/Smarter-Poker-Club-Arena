import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TableSettingsPanel } from '../../src/components/table/TableSettingsPanel';
import { DEFAULT_USER_TABLE_SETTINGS } from '../../src/hooks/useUserTableSettings';

describe('TableSettingsPanel background refresh', () => {
  it('keeps cached controls usable while the canonical row is loading', async () => {
    const onToggle = vi.fn();
    render(
      <TableSettingsPanel
        settings={DEFAULT_USER_TABLE_SETTINGS}
        loading
        onToggle={onToggle}
        mode="inline"
      />
    );

    expect(screen.getByText('Refreshing Settings In Background...')).toBeInTheDocument();
    const showStack = screen.getByRole('switch', { name: 'Show Stack In Big Blinds' });
    await waitFor(() => expect(showStack).toBeVisible());
    fireEvent.click(showStack);
    expect(onToggle).toHaveBeenCalledWith('show_stack_in_bb');
  });
});
