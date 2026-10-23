import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import LobbyTable from '../../../src/components/lobby/LobbyTable';
import { cashEntry } from '../../../src/components/lobby/lobbyEntries';

const entries = ['classic', 'action', 'madness'].map((template, index) =>
  cashEntry({
    id: `fixture-${template}`,
    name: template,
    game_variant: 'plo6',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 6 - index,
    max_players: 6,
    status: 'active',
    cluster_id: `cluster-${template}`,
    cluster_template: template,
    cluster_players: 12 - index,
    cluster_tables: 2,
  })
);
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <main className="club-home">
      <div className="club-lobby-machine">
        <LobbyTable
          entries={entries}
          category="OMAHA"
          selectedId={null}
          onSelect={() => {
            document.body.dataset.selected = 'true';
          }}
          onActivate={() => {}}
          ctx={{
            waitlistedIds: new Set(),
            seatedIds: new Set(),
            registeredIds: new Set(),
            favoriteIds: new Set(),
          }}
        />
      </div>
    </main>
  </MemoryRouter>
);
