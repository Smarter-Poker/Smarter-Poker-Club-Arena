/**
 * ♠ CLUB ARENA — Database Types
 * TypeScript types for Supabase tables
 */

export interface Database {
    public: {
        Tables: {
            clubs: {
                Row: Club;
                Insert: Omit<Club, 'id' | 'created_at' | 'updated_at'>;
                Update: Partial<Omit<Club, 'id'>>;
            };
            club_members: {
                Row: ClubMember;
                Insert: Omit<ClubMember, 'id' | 'joined_at'>;
                Update: Partial<Omit<ClubMember, 'id'>>;
            };
            tables: {
                Row: PokerTable;
                Insert: Omit<PokerTable, 'id' | 'created_at'>;
                Update: Partial<Omit<PokerTable, 'id'>>;
            };
            chip_transactions: {
                Row: ChipTransaction;
                Insert: Omit<ChipTransaction, 'id' | 'created_at'>;
                Update: never;
            };
            unions: {
                Row: Union;
                Insert: Omit<Union, 'id' | 'created_at'>;
                Update: Partial<Omit<Union, 'id'>>;
            };
        };
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface Club {
    id: string;
    club_id: number; // 6-digit public ID
    name: string;
    description: string | null;
    avatar_url: string | null;
    owner_id: string;
    is_public: boolean;
    requires_approval: boolean;
    gps_restricted: boolean;
    created_at: string;
    updated_at: string;
    settings: ClubSettings;
}

export interface ClubSettings {
    default_rake_percent: number;
    rake_cap: number;
    time_bank_seconds: number;
    allow_straddle: boolean;
    allow_run_it_twice: boolean;
    min_buy_in_bb: number;
    max_buy_in_bb: number;
}

export interface ClubMember {
    id: string;
    club_id: string;
    user_id: string;
    role: MemberRole;
    nickname: string | null;
    chip_balance: number;
    joined_at: string;
    status: MemberStatus;
    agent_id: string | null; // If this member is managed by an agent
}

export type MemberRole = 'owner' | 'admin' | 'agent' | 'member';
export type MemberStatus = 'active' | 'pending' | 'suspended' | 'banned';

export interface PokerTable {
    id: string;
    club_id: string;
    tournament_id?: string | null;
    name: string;
    game_type: GameType;
    game_variant: GameVariant;
    stakes: string; // e.g., "1/2", "5/10"
    small_blind: number;
    big_blind: number;
    min_buy_in: number;
    max_buy_in: number;
    max_players: number;
    current_players: number;
    status: TableStatus;
    settings: TableSettings;
    created_at: string;
}

export type GameType = 'cash' | 'tournament' | 'sit_n_go';
export type GameVariant =
    | 'nlh' | 'flh' | 'plo4' | 'plo5' | 'plo6'
    | 'plo_hilo' | 'plo8' | 'short_deck' | 'ofc' | 'ofc_pineapple';
export type TableStatus = 'waiting' | 'running' | 'paused' | 'closed';

export interface TableSettings {
    straddle_enabled: boolean;
    straddle_type: 'utg' | 'any_position' | 'mississippi';
    run_it_twice: boolean;
    bomb_pot_enabled: boolean;
    bomb_pot_frequency: number; // Every N hands
    bomb_pot_ante_bb: number;
    time_bank_seconds: number;
    auto_muck: boolean;
}

export interface ChipTransaction {
    id: string;
    club_id: string;
    from_user_id: string | null; // null = club/system
    to_user_id: string;
    amount: number;
    type: TransactionType;
    reference_id: string | null; // Related table/tournament ID
    notes: string | null;
    created_at: string;
}

export type TransactionType =
    | 'deposit' | 'withdrawal' | 'buy_in' | 'cash_out'
    | 'agent_transfer' | 'rake' | 'bonus';

export interface Union {
    id: string;
    name: string;
    description: string | null;
    owner_id: string;
    club_count: number;
    member_count: number;
    created_at: string;
    settings: UnionSettings;
}

export interface UnionSettings {
    revenue_share_percent: number;
    shared_player_pool: boolean;
    cross_club_tournaments: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent System (PokerBros-style chip distribution)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Agent {
    id: string;
    club_id: string;
    user_id: string;
    member_id: string; // Link to club_members
    name: string;
    chip_balance: number;
    commission_rate: number; // % of rake returned to players
    player_count: number;
    is_active: boolean;
    created_at: string;
}

export interface AgentPlayer {
    id: string;
    agent_id: string;
    user_id: string;
    nickname: string;
    chip_balance: number;
    rakeback_percent: number;
    joined_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// User Profile
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    vip_level: VipLevel;
    stats: PlayerStats;
    created_at: string;
}

export type VipLevel = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

export interface PlayerStats {
    total_hands: number;
    vpip: number;
    pfr: number;
    aggression_factor: number;
    bb_per_100: number;
    biggest_pot: number;
    total_profit: number;
    games_played: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game State Types (shared with engine)
// ═══════════════════════════════════════════════════════════════════════════════

export type CardSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
    rank: CardRank;
    suit: CardSuit;
}

export interface HandState {
    id: string;
    table_id: string;
    hand_number: number;
    pot: number;
    community_cards: Card[];
    current_bet: number;
    current_player: string | null;
    dealer_seat: number;
    stage: HandStage;
    players: SeatPlayer[];
}

export type HandStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface SeatPlayer {
    seat: number;
    user_id: string;
    username: string;
    stack: number;
    bet: number;
    cards: Card[];
    is_folded: boolean;
    is_all_in: boolean;
    is_sitting_out: boolean;
}

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';

export interface PlayerAction {
    type: ActionType;
    amount?: number;
    timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tournament Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface Tournament {
    id: string;
    club_id: string;
    name: string;
    type: TournamentType;
    buy_in: number;
    rake: number;
    starting_chips: number;
    max_players: number;
    current_players: number;
    status: TournamentStatus;
    blind_structure: BlindLevel[];
    payout_structure: PayoutEntry[];
    prize_pool: number;
    start_time?: string;
    started_at?: string;
    ended_at?: string;
    created_at: string;
}

export type TournamentType = 'sng' | 'mtt' | 'satellite';
export type TournamentStatus = 'scheduled' | 'registering' | 'running' | 'paused' | 'finished' | 'cancelled';

export interface BlindLevel {
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante: number;
    durationMinutes: number;
}

export interface PayoutEntry {
    place: number;
    percentage: number;
}

export interface TournamentPlayer {
    id: string;
    tournament_id: string;
    user_id: string;
    username: string;
    chips: number;
    status: TournamentPlayerStatus;
    position: number | null;
    prize: number | null;
    rebuys?: number;
    add_on?: boolean;
    registered_at: string;
    eliminated_at?: string;
}

export type TournamentPlayerStatus = 'registered' | 'playing' | 'eliminated' | 'winner';

