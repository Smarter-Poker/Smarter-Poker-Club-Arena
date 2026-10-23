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
  const stacked = document.documentElement.dataset.stacked === 'true';
  const [open, setOpen] = useState(!stacked);
  return (
    <>
      {stacked && (
        <header
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 76,
            zIndex: 390,
            background: '#000',
          }}
        >
          <button
            type="button"
            style={{ position: 'absolute', right: 0, top: 0, width: 100, height: 76 }}
          >
            Messages
          </button>
        </header>
      )}
      <main
        style={
          stacked
            ? { position: 'relative', isolation: 'isolate', zIndex: 0, paddingTop: 100 }
            : undefined
        }
      >
        {stacked && (
          <button type="button" onClick={() => setOpen(true)}>
            Open Game Lobby
          </button>
        )}
        {open && (
          <GameLobbyPanel
            entry={entry}
            clubId="fixture"
            currentUserId={null}
            waitlisted={false}
            seated={false}
            registered={false}
            busy={false}
            onClose={stacked ? () => setOpen(false) : noop}
            onJoinTable={noop}
            onWaitlistToggle={noop}
            onRegister={noop}
            onUnregister={noop}
            onSpinJoin={noop}
          />
        )}
      </main>
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
