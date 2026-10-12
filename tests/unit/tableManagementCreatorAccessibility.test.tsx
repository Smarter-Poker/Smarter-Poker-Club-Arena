import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: mocks.confirm,
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import CreateTournamentModal from '../../src/components/club/CreateTournamentModal';

const ROOT = process.cwd();

function CreatorHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Tournament Creator
      </button>
      {open && (
        <CreateTournamentModal
          clubId="accessibility-club"
          onClose={() => setOpen(false)}
          onSuccess={() => setOpen(false)}
        />
      )}
    </>
  );
}

function renderDirtyCreator(onClose = vi.fn()) {
  render(
    <CreateTournamentModal clubId="accessibility-club" onClose={onClose} onSuccess={vi.fn()} />
  );
  fireEvent.change(screen.getByLabelText(/Tournament Name/), {
    target: { value: 'Protected Draft' },
  });
  return onClose;
}

describe('Table Management creator accessibility', () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('focuses the first creator field and restores the trigger after a clean close', async () => {
    const user = userEvent.setup();
    render(<CreatorHarness />);
    const opener = screen.getByRole('button', { name: 'Open Tournament Creator' });
    opener.focus();

    await user.click(opener);
    await waitFor(() => expect(screen.getByLabelText(/Tournament Name/)).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['Backdrop', () => fireEvent.click(screen.getByRole('dialog', { name: 'Create Game' }))],
    ['Close', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
  ])('uses the same dirty-draft confirmation for %s', async (_path, close) => {
    const onClose = renderDirtyCreator();
    close();

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Discard Tournament Draft?',
        confirmText: 'Discard Draft',
        cancelText: 'Keep Editing',
        variant: 'danger',
      })
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes a dirty draft only after the operator confirms', async () => {
    mocks.confirm.mockResolvedValue(true);
    const onClose = renderDirtyCreator();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('protects edits outside the name and buy-in fields while leaving seeded defaults clean', async () => {
    const onClose = vi.fn();
    render(
      <CreateTournamentModal clubId="accessibility-club" onClose={onClose} onSuccess={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText(/Game \*/), { target: { value: 'PLO4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps every visible creator label programmatically connected', () => {
    for (const file of [
      'src/components/club/CreateTournamentModal.tsx',
      'src/pages/TableConfigPage.tsx',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      const labels = source.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
      for (const label of labels) {
        const htmlFor = label.match(/htmlFor="([^"]+)"/)?.[1];
        if (htmlFor) {
          expect(source, `${file}: missing control for ${htmlFor}`).toContain(`id="${htmlFor}"`);
        } else {
          expect(label, `${file}: label must wrap its control`).toMatch(
            /<(?:input|select|textarea)\b/
          );
        }
      }

      for (const labelledBy of source.matchAll(/aria-labelledby="([^"]+)"/g)) {
        if (!labelledBy[1].endsWith('-label')) continue;
        expect(source, `${file}: missing label id ${labelledBy[1]}`).toContain(
          `id="${labelledBy[1]}"`
        );
      }
    }

    const tableConfig = readFileSync(resolve(ROOT, 'src/pages/TableConfigPage.tsx'), 'utf8');
    expect(tableConfig).toContain('aria-label="Table Name"');
  });
});
