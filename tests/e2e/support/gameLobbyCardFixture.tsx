import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import GameLobbyPanel from '../../../src/components/lobby/GameLobbyPanel';
import { cashEntry, tournamentEntry } from '../../../src/components/lobby/lobbyEntries';
import { ToastProvider } from '../../../src/components/common/Toast';
const kind = document.documentElement.dataset.kind || 'cash';
const entry =
  kind === 'cash'
    ? cashEntry({
        id: 'fixture-cash',
        name: 'Classic',
        game_variant: 'plo6',
        small_blind: 1,
        big_blind: 2,
        min_buy_in: 80,
        max_buy_in: 400,
        current_players: 4,
        max_players: 6,
        status: 'active',
      })
    : tournamentEntry(
        {
          id: 'fixture-event',
          name: 'Evening Classic',
          game_type: 'NLH',
          buy_in_amount: 10,
          buy_in_fee: 1,
          guaranteed_prize: kind === 'mtt' ? 1000 : 0,
          start_time: new Date(Date.now() + 3600000).toISOString(),
          status: 'REGISTERING',
          current_players: 1,
          max_players: kind === 'spin' ? 3 : kind === 'sng' ? 2 : 180,
          starting_chips: 10000,
          variant: kind,
          format_contract: kind === 'spin' ? 'spin-v1' : kind === 'sng' ? 'sng-v1' : 'mtt-v1',
        } as any,
        kind as any
      );
const noop = () => undefined;
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Game Lobby
      </button>
      {open && (
        <GameLobbyPanel
          entry={entry}
          clubId="fixture"
          currentUserId={null}
          waitlisted={false}
          seated={false}
          registered={false}
          busy={false}
          onClose={() => setOpen(false)}
          onJoinTable={noop}
          onWaitlistToggle={noop}
          onRegister={noop}
          onUnregister={noop}
          onSpinJoin={noop}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </MemoryRouter>
);
