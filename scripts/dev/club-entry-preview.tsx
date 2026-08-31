import React from 'react';
import { createRoot } from 'react-dom/client';
import ClubEntryActionBar from '../../src/components/home/ClubEntryActionBar';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClubEntryActionBar
      flags={{ create_club: true, find_player: true, join_club: true }}
      onCreate={() => undefined}
      onFind={() => undefined}
      onJoin={() => undefined}
    />
  </React.StrictMode>
);
