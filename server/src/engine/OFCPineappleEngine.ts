/**
 * OFC Pineapple Engine — REMOVED
 * Open Face Chinese was removed from Club Arena.
 * This file is a stub to prevent import errors.
 */

export type OFCSuit = 'h' | 'd' | 'c' | 's';
export type OFCRank = string;
export interface OFCCard { rank: OFCRank; suit: OFCSuit; }
export type OFCRow = 'front' | 'middle' | 'back';
export type OFCHandRank = string;
export interface OFCHand { row: OFCRow; cards: OFCCard[]; }
export interface OFCPlayer { id: string; hands: Record<OFCRow, OFCCard[]>; }
export interface OFCGameState { players: OFCPlayer[]; }

export const FRONT_ROYALTIES: Record<string, number> = {};
export const MIDDLE_ROYALTIES: Record<string, number> = {};
export const BACK_ROYALTIES: Record<string, number> = {};

export class OFCPineappleEngine {
  // No-op stub
}
