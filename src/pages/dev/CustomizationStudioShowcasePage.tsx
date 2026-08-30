import { useEffect, useState } from 'react';
import { ThemeSettingsModal } from '../../components/table/ThemeSettingsModal';
import { masterBus } from '../../core/MasterBus';
import { useWalletStore } from '../../stores/useWalletStore';

const SHOWCASE_USER_ID = '11111111-2222-4333-8444-555555555555';

type LiveSelection = {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
};

const INITIAL_SELECTION: LiveSelection = {
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

// This route is compiled out of normal production navigation and exists so
// Playwright can mount the REAL Table Studio in Chromium rather than testing a
// hand-written HTML imitation. Give its deterministic player enough cached
// diamonds to execute the purchase flow without involving Stripe.
useWalletStore.setState({
  diamonds: 5_000,
  _diamondsUserId: SHOWCASE_USER_ID,
  _diamondsAt: Date.now(),
});

export default function CustomizationStudioShowcasePage() {
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<LiveSelection>(INITIAL_SELECTION);

  useEffect(
    () =>
      masterBus.subscribe('UI_THEME_CHANGED', (event) => {
        if (event.payload.userId && event.payload.userId !== SHOWCASE_USER_ID) return;
        const value = event.payload.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        setSelection((current) => ({ ...current, ...(value as Partial<LiveSelection>) }));
      }),
    []
  );

  return (
    <main data-testid="customization-studio-showcase">
      <button type="button" onClick={() => setOpen(true)}>
        Open Table Studio
      </button>
      <output
        data-testid="customization-live-state"
        data-table-theme={selection.table_id}
        data-background-theme={selection.background_id}
        data-button-theme={selection.button_id}
        data-card-back={selection.cards_id}
        style={{
          position: 'fixed',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
        }}
      >
        {JSON.stringify(selection)}
      </output>
      <ThemeSettingsModal
        isOpen={open}
        onClose={() => setOpen(false)}
        userId={SHOWCASE_USER_ID}
        isVip={false}
      />
    </main>
  );
}
