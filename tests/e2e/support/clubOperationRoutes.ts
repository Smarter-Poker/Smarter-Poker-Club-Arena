/**
 * Node-safe mirror of the permission-filtered Club Operations registry used by
 * the authenticated production route sweep. Application imports are avoided
 * because the registry reaches Vite-only media URL helpers during Playwright
 * discovery. A Vitest contract compares id, label, and suffix with the real
 * registry so this list cannot silently drift.
 */
export const ADMIN_CLUB_OPERATION_ROUTES = [
  { id: 'overview', label: 'Overview', suffix: 'operations', marker: 'Club Operations' },
  { id: 'dashboard', label: 'Dashboard', suffix: 'dashboard-full', marker: 'New Table' },
  { id: 'players', label: 'Players', suffix: 'members', marker: 'Player Command' },
  { id: 'agents', label: 'Agent Team', suffix: 'agents', marker: 'Agent Management' },
  { id: 'reports', label: 'Reports', suffix: 'reports', marker: 'Player Report Review' },
  { id: 'hand-review', label: 'Hand Review', suffix: 'hand-review', marker: 'Open A Hand' },
  {
    id: 'agent-network',
    label: 'Agent Network',
    suffix: 'agent-dashboard',
    marker: 'You Are Not An Agent In This Club',
  },
  { id: 'anti-cheat', label: 'Anti-Cheat', suffix: 'anti-cheat', marker: 'Anti-Cheat Dashboard' },
  { id: 'disputes', label: 'Disputes', suffix: 'disputes', marker: 'Dispute Resolution Desk' },
  { id: 'blacklist', label: 'Blacklist', suffix: 'blacklist', marker: 'Club Exclusion Control' },
  {
    id: 'finance-overview',
    label: 'Finance Overview',
    suffix: 'finance',
    marker: 'Finance & Risk',
  },
  { id: 'data', label: 'Club Data', suffix: 'data', marker: 'Read The Room' },
  { id: 'financials', label: 'Financials', suffix: 'financials', marker: 'Financials' },
  { id: 'cashier', label: 'Cashier', suffix: 'cashier', marker: 'Cashier' },
  {
    id: 'diamond-wheel',
    label: 'Diamond Wheel',
    suffix: 'wheel-operations',
    marker: 'Diamond Wheel',
  },
  {
    id: 'diamond-games',
    label: 'Diamond Games',
    suffix: 'diamond-games-operations',
    marker: 'Diamond Plinko',
  },
  {
    id: 'diamond-costs',
    label: 'Diamond Costs',
    suffix: 'diamond-costs',
    marker: 'Diamond Costs',
  },
  {
    id: 'settlement',
    label: 'Settlement',
    suffix: 'settlement',
    marker: 'Weekly Accounting',
  },
  {
    id: 'insurance',
    label: 'Insurance Report',
    suffix: 'insurance-report',
    marker: 'Insurance Report',
  },
  {
    id: 'bomb-pot-report',
    label: 'Bomb Pot Report',
    suffix: 'bomb-pot-report',
    marker: 'Bomb Pot Report',
  },
  {
    id: 'control-overview',
    label: 'Control Overview',
    suffix: 'control',
    marker: 'Club Control',
  },
  {
    id: 'announcements',
    label: 'Announcements',
    suffix: 'announcements',
    marker: 'Announcements',
  },
  {
    id: 'promotions',
    label: 'Player Offers',
    suffix: 'promotions',
    marker: 'Promotions',
  },
  { id: 'promo-vault', label: 'Promo Vault', suffix: 'promo-vault', marker: 'Promo Vault' },
  {
    id: 'table-management',
    label: 'Table Management',
    suffix: 'table-management',
    marker: 'Table Management',
  },
  { id: 'rules', label: 'Club Rules', suffix: 'rules', marker: 'Club Rules' },
  { id: 'settings', label: 'Settings', suffix: 'settings', marker: 'Share Club' },
] as const;
