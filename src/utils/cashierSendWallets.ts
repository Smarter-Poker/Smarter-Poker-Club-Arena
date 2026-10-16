import { canHoldAgentWallet, holdsPlayerWallet } from '../components/wallet/walletRows';

export type SendSource =
  | 'agent_wallet'
  | 'club_bank'
  | 'promo_wallet'
  | 'club_promo_wallet'
  | 'player_wallet';
export type SendDestination = 'player_wallet' | 'agent_wallet' | 'promo_wallet';
export const SEND_SOURCE_LABELS: Record<SendSource, string> = {
  player_wallet: 'Your Player Wallet',
  agent_wallet: 'Your Agent Wallet',
  club_bank: 'The Main Bank',
  promo_wallet: 'Your Promo Wallet',
  club_promo_wallet: 'The Club Promo Wallet',
};
export const SEND_DESTINATION_LABELS: Record<SendDestination, string> = {
  player_wallet: 'Player Wallet',
  agent_wallet: 'Agent Wallet',
  promo_wallet: 'Promo Wallet',
};
export function recipientSendWallets(role: unknown): SendDestination[] {
  return [
    ...(canHoldAgentWallet(role) ? (['agent_wallet', 'promo_wallet'] as const) : []),
    ...(holdsPlayerWallet(role) ? (['player_wallet'] as const) : []),
  ];
}
