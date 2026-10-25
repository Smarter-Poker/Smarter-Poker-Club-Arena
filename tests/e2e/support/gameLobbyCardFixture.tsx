import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import GameLobbyPanel from '../../../src/components/lobby/GameLobbyPanel';
import { cashEntry, tournamentEntry } from '../../../src/components/lobby/lobbyEntries';
import { ToastProvider } from '../../../src/components/common/Toast';
import TickerRail from '../../../src/components/tournament/TickerRail';
import { startingSoonItem } from '../../../src/components/tournament/tickerMessages';
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
const now = Date.now();
const tickerItems = [
  startingSoonItem({
    id: 'fixture-starting',
    name: 'Evening Classic',
    startsAt: now + 180_000,
    clubId: 'fixture',
    buyIn: 10,
    buyInFee: 1,
    registered: 18,
    isRegistered: false,
  }),
];
function Fixture() {
  const [open, setOpen] = useState(true);
  const [tickerOpens, setTickerOpens] = useState(0);
  return (
    <>
      {createPortal(
        <TickerRail
          items={tickerItems}
          now={now}
          top={document.querySelector('header.header')!.getBoundingClientRect().bottom}
          appearance={{
            backgroundColor: '#000000',
            textColor: '#ffffff',
            accentColor: '#00d4ff',
            fontFamily: 'Inter',
            speedSeconds: 22,
          }}
          onOpen={() => setTickerOpens((count) => count + 1)}
          onDismiss={noop}
          containerRef={(node) => {
            if (node)
              document.documentElement.style.setProperty(
                '--mtt-ticker-h',
                `${node.offsetHeight}px`
              );
          }}
        />,
        document.body
      )}
      <output aria-label="Ticker Open Count">{tickerOpens}</output>
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
