const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

// 1. Remove 'ALL' and order: MTT, Hold'em, Omaha, Spin, Heads Up
code = code.replace(
  `const GAME_TYPE_TABS: { key: GameType; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'HOLDEM', label: "Hold'em" },
  { key: 'OMAHA', label: 'Omaha' },
  { key: 'MTT', label: 'MTT' },
  { key: 'SNG', label: 'Heads Up' },
  { key: 'SPIN', label: 'Spin' },
];`,
  `const GAME_TYPE_TABS: { key: GameType; label: string }[] = [
  { key: 'MTT', label: 'MTT' },
  { key: 'HOLDEM', label: "Hold'em" },
  { key: 'OMAHA', label: 'Omaha' },
  { key: 'SPIN', label: 'Spin' },
  { key: 'SNG', label: 'Heads Up' },
];`
);

// 2. Change sort label
code = code.replace(
  `  { key: 'starting_soon', label: 'Starting Soonest' },`,
  `  { key: 'starting_soon', label: 'Starting Soon / Late Reg' },`
);

// 3. Default MTT to starting_soon
// First, find the onClick for the tabs
code = code.replace(
  `              onClick={() => {
                haptic.selection();
                setGameType(tab.key);
                setSortOpen(false);
              }}`,
  `              onClick={() => {
                haptic.selection();
                setGameType(tab.key);
                setSortOpen(false);
                if (tab.key === 'MTT' && sort === 'recommended') {
                  setSort('starting_soon');
                }
              }}`
);

// If the page loads with MTT as default (it might now that ALL is gone),
// wait, we should also change the initial state if it was 'ALL'.
code = code.replace(
  `const [gameType, setGameType] = useState<GameType>('ALL');`,
  `const [gameType, setGameType] = useState<GameType>('MTT');`
);

// Also set sort to starting_soon if default is MTT
// Actually, `useState<SortKey>('recommended')` is fine, we can just let useEffect handle it, or change the default.
code = code.replace(
  `const [sort, setSort] = useState<SortKey>('recommended');`,
  `const [sort, setSort] = useState<SortKey>('starting_soon'); // Default to starting_soon since MTT is first tab`
);

// 4. Implement filtering for starting_soon
// Replace the starting_soon case in the sorting logic
code = code.replace(
  `      case 'starting_soon':
        return rows.sort(
          (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
        );`,
  `      case 'starting_soon': {
        const isLateReg = (t: TournamentData) => {
          const status = String(t.status).toUpperCase();
          if (status === 'REGISTERING') return true;
          if (status === 'RUNNING') {
             const lateReg = Number(t.late_reg_levels) || Number(t.late_reg_mins) || 0;
             const current = Number(t.current_level) || 1;
             return lateReg > 0 && current <= lateReg;
          }
          return false;
        };
        const activeOnly = rows.filter(isLateReg);
        return activeOnly.sort(
          (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
        );
      }`
);

fs.writeFileSync('src/pages/ClubHomePage.tsx', code);
