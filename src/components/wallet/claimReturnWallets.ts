/** Return wallets owned by the claimant; promo cannot become cash on reclaim. */
export type ClaimDestination =
  | 'club_bank'
  | 'club_promo_wallet'
  | 'agent_wallet'
  | 'player_wallet'
  | 'promo_wallet';
export const CLAIM_DESTINATION_LABELS: Record<ClaimDestination, string> = {
  club_bank: 'Club Bank',
  club_promo_wallet: 'Club Promo Wallet',
  agent_wallet: 'My Agent Wallet',
  player_wallet: 'My Player Wallet',
  promo_wallet: 'My Promo Wallet',
};
export function claimReturnWallets(source: string, role: string): ClaimDestination[] {
  const staff = ['owner', 'co_owner', 'admin'].includes(role);
  if (source === 'promo_wallet')
    return staff ? ['promo_wallet', 'club_promo_wallet'] : ['promo_wallet'];
  return [
    'agent_wallet',
    ...(role === 'admin' ? [] : ['player_wallet' as const]),
    'promo_wallet',
    ...(staff ? ['club_bank' as const, 'club_promo_wallet' as const] : []),
  ];
}
