/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SMARTER POKER — Server-Side Types
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shared types for the server-side game engine.
 * Mirrors client types but standalone — NO imports from client code.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Card Types
// ─────────────────────────────────────────────────────────────────────────────

export type CardSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: CardRank;
  suit: CardSuit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Types
// ─────────────────────────────────────────────────────────────────────────────

// FIX 120: Added 'pineapple_discard' stage for Crazy Pineapple (discard after flop)
export type HandStage = 'preflop' | 'flop' | 'pineapple_discard' | 'turn' | 'river' | 'showdown';
// FIX 120: Added 'discard' action for Crazy Pineapple
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard';
// FIX 116: Dead variants removed (plo, plo_hilo, mixed) — Dan's approved variants only.
//
// 2026-08-23: `flh` comes BACK, and `flo8` joins it. FIX 116 removed them as
// "dead" because nothing could create one — but the lobby's LIMIT tab and
// ClubHomePage.cashKind() never stopped classifying on them, so the tab was
// permanently empty and there was no way to fill it. They are dead no longer:
// the engine now plays them fixed-limit (see engine/BettingStructure.ts) rather
// than dealing a limit game and betting it no-limit.
export type GameVariant =
  | 'nlh'
  | 'plo4'
  | 'plo5'
  | 'plo6'
  | 'plo8'
  | 'pineapple'
  | 'short_deck'
  | 'flh' // Fixed Limit Hold'em
  | 'flo8'; // Fixed Limit Omaha Hi-Lo

/** Bible V8 §3.1: Full table state machine states */
export type TableStatus =
  | 'empty'
  | 'waiting'
  | 'seating'
  | 'running'
  | 'paused'
  | 'closing'
  | 'closed';

// ─────────────────────────────────────────────────────────────────────────────
// Player Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatPlayer {
  seat: number;
  user_id: string;
  username: string;
  stack: number;
  bet: number;
  totalInvested: number;
  /**
   * WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): cumulative uncalled amount
   * returned to this player this hand. returnUncalledBet() already decrements
   * totalInvested when it refunds the uncalled portion, so totalInvested is
   * the player's ELIGIBLE contribution; this field preserves the returned
   * amount as first-class audit state (gross = totalInvested + returnedUncalled).
   */
  returnedUncalled?: number;
  /**
   * Dead money portion of totalInvested — antes, a Big Blind Ante posted by the
   * BB on behalf of the whole table, and dead small blinds. Dead money sits in
   * the pot but must NOT count as a live bet: it is excluded from uncalled-bet
   * detection and from side-pot level calculation (otherwise the poster gets a
   * private side pot / an uncalled-bet refund for chips that belong to the pot).
   */
  deadInvested?: number;
  /** Individual ante within deadInvested, retained for partial-ante pot caps.
   * BBA and dead blinds remain shared dead money and never populate this field. */
  individualAnteInvested?: number;
  cards: Card[];
  is_folded: boolean;
  is_all_in: boolean;
  is_sitting_out: boolean;
  /** Bible V8 §2.3: Added in broadcast — true when heartbeat missed */
  is_disconnected?: boolean;
  /** Bible V8 §2.3: Seconds remaining in time bank pool */
  time_bank_remaining?: number;
  /** Bible V8 §2.3: Number of time bank activations left this session */
  time_bank_uses_remaining?: number;
  /** Bible V8 §2.3: Position label (BTN, SB, BB, UTG, MP, CO, HJ, etc.) */
  position?: string;
  /** Bible V8 §2.3: Player avatar URL */
  avatar_url?: string;
  /**
   * Equipped avatar frame token, e.g. `frame-gold`. Travels with `avatar_url`
   * because it is drawn on top of it; a client that has one and not the other
   * renders a ring around the wrong picture. Empty string means none.
   */
  equipped_frame?: string;
  /** Equipped avatar aura token, e.g. `aura-fire`. Empty string means none. */
  equipped_aura?: string;
  /** Bible V8 §2.3: Whether this player is an AI horse */
  is_horse?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TableInfo {
  id: string;
  club_id: string;
  small_blind: number;
  big_blind: number;
  game_variant: GameVariant;
  max_players: number;
  ante?: number;
  game_type?: string;
  tournament_id?: string;
  action_time_seconds?: number;
  /** Bible V8 §4.3: Big Blind Ante — BB posts ante for entire table */
  big_blind_ante_enabled?: boolean;
  /** 2026-08-22 parity: All-in-or-Fold table — preflop actions are fold or shove only */
  all_in_or_fold?: boolean;
  /** Bible V8 §4.4: Straddle settings */
  straddle_enabled?: boolean;
  straddle_type?: 'utg'; // FIX 114: Only UTG straddle allowed (2x BB)
  max_straddles?: number;
  /** Bible V8 §4.20: Run It Twice */
  run_it_twice_enabled?: boolean;
  /** Bible V8 §4.19: Insurance */
  insurance_enabled?: boolean;
  /** Bible V8 §4.21: Auto-muck losing hands at showdown */
  auto_muck_enabled?: boolean;
  /** Bible V8 §4.21: Allow players to voluntarily show hand */
  show_hand_enabled?: boolean;
  /** Bible V8 §6.3: Disconnect timeout in seconds */
  disconnect_timeout_seconds?: number;
  /** Bible V8 §1.7.6: Auto sit-out after N consecutive timeouts */
  max_consecutive_timeouts?: number;
  /** Bible V8 §1.7.4: Prefer check over fold on disconnect */
  prefer_check_over_fold?: boolean;
  /** Bible V8 §6.2: Time bank uses per session */
  /**
   * Per-table rake override, whole-percent units. -1 (RAKE_INHERIT) means
   * "use the club default, then the published schedule". Clamped in
   * getFullRakeConfig — never trust the raw column, any club admin can UPDATE
   * the row through RLS.
   */
  rake_percent?: number;
  /** Per-table rake cap override, in BIG BLINDS. -1 means inherit. */
  rake_cap_bb?: number;
  time_bank_max_uses?: number;
  /** Bible V8 §6.2: Whether time bank feature is enabled */
  time_bank_enabled?: boolean;
  run_it_twice?: boolean;
  allow_run_it_twice?: boolean;
  /** Bible V8 §4.3: Whether ante is enabled */
  ante_enabled?: boolean;
  /** Bible V8 §4.22: Whether bomb pots are enabled */
  bomb_pot_enabled?: boolean;
  /** Bible V8 §4.22: Bomb pot frequency — every N hands */
  bomb_pot_frequency?: number;
  /** Bible V8 §4.22: Bomb pot ante multiplier (× BB) */
  bomb_pot_ante_multiplier?: number;
  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20 (Dan's competitor-parity directive):
   * when true, bomb-pot hands deal TWO full boards and split every pot in
   * half across them at showdown.
   */
  bomb_pot_double_board?: boolean;
  /* ── BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec) ──────────────────
     The canonical configuration surface. The legacy trio above
     (frequency / ante multiplier / double board) still works and is what
     old rows carry; these override it when present. Every field here must
     also be in the loadTable select in services/supabase/tables.ts AND in
     the throttled re-read in ServerTableEngineBase. */
  /** Boards dealt on a bomb-pot hand: 1, 2 or 3. Overrides bomb_pot_double_board. */
  bomb_pot_board_count?: number;
  /** 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only' */
  bomb_pot_trigger_mode?: string | null;
  /** TIMED mode: seconds between bomb pots (server clock, next hand boundary). */
  bomb_pot_interval_seconds?: number | null;
  /** A due bomb stays pending until this many players are dealt in. Default 3. */
  bomb_pot_min_players?: number;
  /** FIXED ante mode: exact chip amount. When > 0, overrides the BB multiplier. */
  bomb_pot_ante_fixed?: number | null;
  /**
   * VARIANT OVERRIDE (spec §10.1): the bomb HAND's variant when it differs
   * from the table's — e.g. an NLH table dealing PLO4 double-board bombs.
   * NULL = same as table. Whitelisted in resolveBombPotVariant AND by the
   * tables_bomb_pot_variant_check constraint.
   */
  bomb_pot_variant?: string | null;
  /**
   * TIMED PERSISTENCE (spec §4.3): the timed mode's next due timestamp,
   * written by the engine when the clock is (re)set and read back at boot so
   * a deploy no longer restarts the cycle.
   */
  bomb_pot_next_due_at?: string | null;
  /**
   * FULL SCHEDULER PERSISTENCE (2026-08-28): the BombPotScheduler's complete
   * serialized trigger state (every-N counter, orbit anchor, pending token,
   * timed clock, separate bomb button). Engine-written; read once at boot.
   */
  bomb_pot_sched_state?: unknown;
  /**
   * MANUAL_NEXT_HAND (spec §2.1): set by fn_request_manual_bomb_pot
   * (role-gated + audited); the engine consumes and clears it at the next
   * valid hand boundary. Read fresh each hand on bomb-enabled tables.
   */
  bomb_pot_manual_pending?: boolean;
  /** SEPARATE BOMB BUTTON (spec §5.3): 'regular' (default) | 'separate'. */
  bomb_pot_button_policy?: string | null;
  /**
   * TIMED ANNOUNCE WINDOW (spec §3): show the felt countdown only within this
   * many seconds of the due time. NULL = always show.
   */
  bomb_pot_announce_seconds?: number | null;
  /** Bible V8 §2.1: Minimum players to start a hand */
  min_players?: number;
  /** Bible V8 §2.1: Table display name */
  name?: string;
  /** Bible V8 §4.2: Wait-for-BB — new players must wait for BB to reach them */
  wait_for_big_blind?: boolean;
  /** Bible V8 §4.2: Auto-post blinds when returning from sit-out */
  auto_post_blinds?: boolean;
  /** Bible V8 §4.2: Require missed blind post when re-entering */
  post_dead_blind?: boolean;
  /** Bible V8 §6.17: Admin pause lock — prevents new hands from starting */
  pause_lock?: boolean;
  /** Bible V8 §6.17: Maintenance lock — table is in maintenance mode */
  maintenance_lock?: boolean;
  /** Bible V8 §6.15: Observer mode enabled — spectators can watch */
  observer_enabled?: boolean;
  /** Bible V8 §6.15: Show hole cards to observers during play */
  observer_show_cards?: boolean;
  /** Buy-in limits from database — used for add-on cap enforcement */
  min_buy_in?: number;
  max_buy_in?: number;
  /* ── Parity pass, Dan 2026-08-25 ────────────────────────────────────────
     Each of these is a control a host has always been able to set and the
     engine has never been able to see. Adding a field here is necessary and
     not sufficient: it must also be in the loadTable select in
     services/supabase/tables.ts, which is the real contract. */
  /** Seats that must be filled before a hand is dealt. Clamped at 2. */
  auto_start_players?: number;
  /** 'none' | 'player_choice' | 'mandatory_twice' | 'mandatory_three' */
  run_it_mode?: string | null;
  /** Hide usernames and avatars in the broadcast state. */
  is_anonymous?: boolean;
  /** Silence table chat. Enforced in RLS; carried here for the UI mirror. */
  ban_chat?: boolean;
  /** Refuse a socket from anyone not holding a seat. */
  restrict_observers?: boolean;
  /** Per-hand betting cap. cap_bb is the ceiling in big blinds. */
  cap_enabled?: boolean;
  cap_bb?: number | null;
  /** Deal a Hold'em table as Pineapple. See dealtGameVariant. */
  pineapple_holdem?: boolean;
  /**
   * NIT GAME. The master switch for the three VPIP numbers below; with it off
   * they do nothing. The rules themselves live in SQL (fn_nit_check /
   * fn_nit_evictions) because the VPIP they measure is already stored per hand
   * in ca_hand_facts -- computing it a second time here is how two answers to
   * the same question appear. These four are carried so the engine can skip
   * the round trip entirely on the tables that have the rule switched off,
   * which is all of them today.
   */
  nit_game?: boolean;
  /** Minimum VPIP at THIS table, checked between hands. 0 disables. */
  maintain_percent_min?: number | null;
  /** Hands at this table before the maintain rule may judge. */
  maintain_hands?: number | null;
  /** Minimum LIFETIME VPIP, checked at the door by atomic_table_buyin. */
  career_percent_min?: number | null;
  /** Operation Table Stakes: the cash game this table belongs to (null for a
   *  pre-cutover fleet table). Read by the must-move hooks. */
  cluster_id?: string | null;
  role?: 'main' | 'feeder' | null;
  main_index?: number | null;
  lifecycle?: 'opening' | 'live' | 'breaking' | 'closed' | null;
}

export interface SeatedPlayer {
  /** Database-generated seating identity, required at every cashout boundary. */
  occupancy_id?: string;
  /** Server-only, authoritative membership used by disconnect protection. */
  reconnect_membership?: {
    is_vip?: boolean | null;
    vip_tier?: string | null;
    vip_expires_at?: string | null;
  };
  user_id: string;
  username: string;
  stack: number;
  seat_number: number;
  is_horse: boolean;
  /**
   * AUDIT V2 (2026-07-23): profiles.horse_profile is a jsonb column — value may
   * be a plain string ("tag") or an object ({"style":"tag","aggression":1.05}).
   * Always resolve through resolveHorseStyle() in HorseLogic.
   */
  horse_profile?: string | Record<string, unknown>;
  time_bank_remaining?: number;
  time_bank_uses_remaining?: number;
  /** Raw values from this roster read, never an optimistic write acknowledgement. */
  persisted_time_bank?: {
    remainingSeconds: number | null;
    usesRemaining: number | null;
  };
  /**
   * Persisted sit-out flag from `table_seats`. Restart fidelity, 2026-08-25:
   * the engine writes this column and, until now, never read it — so a restart
   * between hands dealt cards to a player who had sat out.
   */
  is_sitting_out?: boolean;
  /**
   * Persisted sit-out CLOCK from `table_seats.sit_out_at` (2026-08-28). ISO
   * string, or null when not sitting out. The boolean above already survived a
   * restart; this is what makes the five-minute cash eviction survive one too —
   * without it `sitOutSince` was re-stamped to now() on every engine boot and
   * the limit could never mature. Written only by trg_stamp_sit_out_at.
   */
  sit_out_at?: string | null;
  /** Bible V8 §2.3: Player avatar for broadcast */
  avatar_url?: string;
  /** Equipped avatar frame token for broadcast, e.g. `frame-gold`. */
  equipped_frame?: string;
  /** Equipped avatar aura token for broadcast, e.g. `aura-fire`. */
  equipped_aura?: string;
  /** Bible V8 §4.2: Player returning from sit-out must post dead blind */
  returning_from_sitout?: boolean;
  /** Bible V8 §4.2: Player is waiting for BB position before playing */
  waiting_for_big_blind?: boolean;
  /** Bible V8 §4.2: Player must post forced (dead) blind to re-enter */
  forced_post_required?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HandConfig {
  tableId: string;
  handNumber: number;
  /**
   * Is this hand being played in a TOURNAMENT (spin, sit-n-go or MTT)?
   *
   * Dan 2026-08-28, binding: "IN SPINS, ITS A TOURNAMENT, SO THE 'SHOW CARDS'
   * POP UP SHOULD NEVER EVER APPEAR, ALL CARDS ARE ALWAYS SHOWN AT SHOWDOWN."
   *
   * Read by applyShowdownRevealRules, which otherwise lets a hand that cannot
   * win or tie any pot stay face-down. In a tournament every hand that reaches
   * showdown is tabled, so the muck branch is skipped entirely.
   */
  isTournament?: boolean;
  gameVariant: GameVariant;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  /** Bible V8 §4.3: Big Blind Ante — BB posts ante for entire table */
  bigBlindAnte?: boolean;
  /**
   * 2026-08-22 parity: All-in-or-Fold. Preflop the only actions are fold or
   * all-in (the BB may check when unraised); with everyone all-in or folded
   * preflop there is no postflop action to restrict.
   */
  allInOrFold?: boolean;
  /** Bible V8 §4.4 / FIX 114: UTG straddle only (2× BB) */
  straddles?: { seat: number; amount: number }[];
  rakeConfig: RakeConfig;
  bombPot?: {
    anteMultiplier: number;
    /**
     * DOUBLE-BOARD BOMB POT 2026-08-20: deal two boards and split every pot
     * across them. HandController downgrades to a single board when the deck
     * cannot cover players × holeCards + 10 board cards.
     *
     * BOMB POT STANDARDIZATION 2026-08-27: legacy alias for boardCount 2.
     * boardCount wins when both are present.
     */
    doubleBoard?: boolean;
    /**
     * BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec §3): boards dealt this
     * hand — 1, 2 or 3. HandController downgrades stepwise (3 → 2 → 1) when
     * the deck cannot cover players × holeCards + 5 × boards cards.
     */
    boardCount?: 1 | 2 | 3;
    /**
     * FIXED ante (spec §3 anteMode FIXED): exact chip amount per participant.
     * When > 0 it overrides bigBlind × anteMultiplier.
     */
    anteFixed?: number;
    /**
     * Why this hand is a bomb pot — frozen into the hand config so hand
     * history can explain the trigger (spec §20). One of
     * 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only'.
     */
    triggerReason?: string;
  };
  /** Bible V8 §2.8 / §4.20: Whether Run It Twice is enabled for this hand */
  ritEnabled?: boolean;
  /** Bible V8 §2.8 / §4.19: Whether Insurance is enabled for this hand */
  insuranceEnabled?: boolean;
  /** Bible V8 §4.2: Dead blinds — seats of players returning from sit-out who must post SB+BB */
  deadBlinds?: { seat: number }[];
  /**
   * AUDIT FIX 2026-07-19: seats of NEW players who chose "Post BB to enter".
   * They post ONLY a live big blind (no dead SB) — they haven't missed a blind,
   * they're buying in early out of position. Distinct from deadBlinds.
   */
  bbOnlyPosts?: { seat: number }[];
  /** Bible V8 §1.9 / Appendix A: BBJ config for this hand */
  bbjConfig?: {
    /** Whether BBJ is enabled for this variant */
    enabled: boolean;
    /** BBJ fee in BB units (e.g., 0.25 means 0.25 × BB per qualifying hand) */
    feeBB: number;
    /** Minimum pot in BB for BBJ eligibility */
    minPotBB: number;
    /** Minimum players dealt in for BBJ eligibility */
    minPlayersDealt: number;
  };
}

export interface GameState {
  stage: HandStage;
  deck: any; // Internal Deck instance — not serialized to clients
  communityCards: Card[];
  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20: the second board. Empty on every hand
   * except an active double-board bomb pot, where it fills in lockstep with
   * communityCards (3/4/5 cards at flop/turn/river).
   */
  communityCards2: Card[];
  /**
   * TRIPLE-BOARD BOMB POT 2026-08-27 (Dan's spec §9): the third board. Empty
   * on every hand except an active triple-board bomb pot, where it fills in
   * lockstep with communityCards and communityCards2.
   */
  communityCards3: Card[];
  pot: number;
  /** Missing SB/BB chips, used only for preflop pot-limit sizing. Never money. */
  potLimitBlindAdjustment?: number;
  currentBet: number;
  lastRaise: number;
  minRaise: number;
  dealerSeat: number;
  currentPlayerSeat: number;
  players: SeatPlayer[];
  pots: Pot[];
  actionHistory: ActionRecord[];
  sawFlop: boolean;
  /** Bible V8 §4.21: Seat of last aggressive bettor/raiser — shows first at showdown */
  lastAggressorSeat: number;
}

/**
 * Bible V8 §2.4 — Hand State Broadcast Payload
 * This is the shape of the object broadcast to all clients via Supabase Realtime.
 * The server constructs this in broadcastCurrentState() and getTableState().
 */
export interface HandStateBroadcast {
  table_id: string;
  hand_number: number;
  pot: number;
  community_cards: Card[];
  /** DOUBLE-BOARD BOMB POT 2026-08-20: second board (empty unless active). */
  community_cards2?: Card[];
  /** TRIPLE-BOARD BOMB POT 2026-08-27: third board (empty unless active). */
  community_cards3?: Card[];
  /**
   * VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant THIS hand is being
   * played as — differs from the table's game on a variant-override bomb pot.
   */
  hand_variant?: string;
  current_bet: number;
  current_player: string; // user_id of player whose turn it is
  dealer_seat: number;
  stage: HandStage;
  min_raise: number;
  last_raise: number;
  /**
   * 2026-08-23: which betting structure this table plays, published rather than
   * re-derived. The client used to ask `gameType.startsWith('plo')` for itself
   * (TablePage), which silently makes every non-PLO variant no-limit — so a
   * fixed-limit table would have drawn a no-limit bet slider.
   */
  betting_structure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
  /** Pot-limit wager basis; the displayed/accounted pot remains `pot`. */
  pot_limit_pot?: number;
  /** Fixed limit only: the street's one legal wager (small bet or big bet). */
  fixed_bet_size?: number;
  /**
   * Fixed limit only: the street has taken its bet and three raises, so only
   * fold and call remain. The client cannot work this out for itself —
   * `action_history` is broadcast but `isFullRaise` is not, and the cap counts
   * full raises.
   */
  wagers_capped?: boolean;
  /** Bible V8 §6.1: Absolute timestamp (ms) when the current turn started */
  turn_start_time_ms: number;
  /** Bible V8 §6.1: Total turn duration in ms (action_time_seconds × 1000) */
  turn_duration_ms: number;
  players: SeatPlayer[];
  pots: Pot[];
  action_history: ActionRecord[];
}

export interface ActionRecord {
  seat: number;
  userId: string;
  action: ActionType;
  amount: number;
  timestamp: number;
  stage: HandStage;
  /** Bible V8 §4.14: Short all-in (less than a full raise) does NOT reopen betting */
  isFullRaise?: boolean;
}

export type HandEvent =
  | { type: 'HAND_START'; handNumber: number; players: SeatPlayer[] }
  | {
      type: 'FORCED_BETS_POSTED';
      postings: Array<{
        seat: number;
        userId: string;
        kind: string;
        amount: number;
        dead: boolean;
      }>;
    }
  | { type: 'CARDS_DEALT'; seat: number; cards: Card[] }
  /**
   * PHASE 4 2026-09-01 - the card a seat threw, for that seat's own replay.
   *
   * A SEPARATE event from PLAYER_ACTION on purpose, and it is the whole
   * security design in one line. `player_action` is the PUBLIC broadcast:
   * it carries a seat and the word 'discard' and nothing card-shaped, because
   * a Crazy Pineapple discard is never revealed to opponents. This event never
   * reaches the hub at all - the engine consumes it and writes the card to the
   * RLS-protected `hand_discards` table, exactly as CARDS_DEALT is consumed
   * and written to `table_hole_cards`.
   *
   * If you ever find yourself forwarding this to the hub, you are re-opening
   * the god-mode hole that created table_hole_cards.
   */
  | { type: 'PINEAPPLE_DISCARDED'; seat: number; card: Card }
  | {
      type: 'COMMUNITY_CARDS';
      stage: HandStage;
      cards: Card[];
      /** DOUBLE-BOARD BOMB POT 2026-08-20: the second board's new cards for this street. */
      cards2?: Card[];
      /** TRIPLE-BOARD BOMB POT 2026-08-27: the third board's new cards for this street. */
      cards3?: Card[];
    }
  /* 2026-09-01: `stage` is carried ON the event, not looked up from live
   * state when the event is handled. See the note in
   * ServerTableEngineHandEvents' PLAYER_ACTION case - reading the mutable
   * controller state at handler time stamped whole hands with whatever stage
   * the hand had ENDED on. Optional so no emitter is silently wrong; the
   * consumer falls back to the old read. */
  | {
      type: 'PLAYER_ACTION';
      seat: number;
      action: ActionType;
      amount: number;
      stage?: HandStage;
    }
  | { type: 'POT_UPDATE'; pot: number; pots: Pot[] }
  | { type: 'TURN_CHANGE'; seat: number; availableActions: ActionType[] }
  | {
      type: 'ALL_IN_RUNOUT';
      board: Card[];
      board2?: Card[];
      /** TRIPLE-BOARD BOMB POT 2026-08-27: third board (present only when active). */
      board3?: Card[];
      pot: number;
      players: SeatPlayer[];
    }
  | { type: 'PINEAPPLE_DISCARD_REQUIRED'; seats: number[] } // FIX 120: Crazy Pineapple
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | {
      type: 'WINNERS';
      winners: Winner[];
      /**
       * DOUBLE-BOARD BOMB POT round 2 (2026-08-20): which board each share
       * came from, with the winning hand's name — the merged `winners` list
       * cannot say "Alice took the top board with a flush, Bob the bottom
       * with a straight". Only present on double-board hands.
       */
      winnersByBoard?: Array<{
        board: 1 | 2 | 3;
        userId: string;
        amount: number;
        handName?: string;
        /**
         * HI-LO (2026-09-04): true on the entry for the LOW half of a split
         * pot. One entry per (board, winner, half); `handName` is then the
         * qualifying low ("Low: 8-6-4-3-2"). Present on every PLO8 / FLO8
         * hand, single board included, so the record can say who took which
         * half - `winners` merges the halves and names only the high hand.
         */
        low?: boolean;
      }>;
      /**
       * SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): the unmerged per-pot(-half)
       * award breakdown — see PerPotAward. Amounts here are already POST-rake:
       * HandController scales the raw pot shares by the global rake ratio and
       * penny-repairs each user's shares against their credited total before
       * this event is emitted. ServerTableEngine groups them verbatim into
       * pot_win's pot_awards.
       */
      perPotAwards?: PerPotAward[];
    }
  | { type: 'UNCALLED_BET_RETURNED'; seat: number; userId: string; amount: number }
  /**
   * DEAD-WIRING FIX 2026-08-15. Bomb pot hands were running silently: the
   * engine collected a forced ante from every seated player and dealt straight
   * to the flop with no preflop betting, and the client was told nothing about
   * it. BombPotOverlay is mounted (TableModalsLayer) and subscribes to the
   * BOMB_POT_TRIGGERED bus event, which had no emitter anywhere. From the
   * player's side chips just vanished from their stack and the hand started on
   * the flop with no explanation.
   */
  | {
      type: 'BOMB_POT_TRIGGERED';
      anteAmount: number;
      bbMultiplier: number;
      /** DOUBLE-BOARD BOMB POT 2026-08-20: whether this hand deals two boards. */
      doubleBoard?: boolean;
      /**
       * BOMB POT STANDARDIZATION 2026-08-27: boards actually dealt this hand
       * (after any deck-feasibility downgrade). 1, 2 or 3. Clients badge the
       * intro with DOUBLE BOARD / TRIPLE BOARD from this, never from config.
       */
      boardCount?: number;
      /** Why this hand is a bomb pot — spec §20 trigger reason (frozen). */
      triggerReason?: string;
      /**
       * Per-seat ante postings so the client can render each ante in front of
       * its seat and sweep them into the pot (reference parity). Presentation
       * data only — the pot math already happened atomically server-side.
       */
      postings?: Array<{ seat: number; userId: string; amount: number }>;
    }
  /**
   * DOUBLE-BOARD BOMB POT 2026-08-20: the bomb-pot hand finished. The client
   * overlay had listened for this since 2026-08-15 with no emitter.
   */
  | { type: 'BOMB_POT_COMPLETED'; handNumber: number }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number; bbjFee: number };

export interface ShowdownResult {
  seat: number;
  userId: string;
  cards: Card[];
  hand: EvaluatedHand;
  /** DOUBLE-BOARD BOMB POT 2026-08-20: the same hole cards evaluated on board 2. */
  hand2?: EvaluatedHand;
  /** TRIPLE-BOARD BOMB POT 2026-08-27: the same hole cards evaluated on board 3. */
  hand3?: EvaluatedHand;
  /**
   * SHOWDOWN SYSTEM 2026-08-25 (Dan spec sections 3-10): position in the
   * table's reveal sequence. 0 = shows first (final-street last aggressor,
   * or first player in normal river action order when the river checked
   * through), then clockwise. Clients stagger the card flips by this index.
   */
  revealOrder?: number;
  /**
   * SHOWDOWN SYSTEM 2026-08-25: true when this hand cannot win or tie any
   * pot it is eligible for against the hands required to show before it, so
   * poker rules permit it to be mucked. The engine — never the client —
   * makes this call. A mucked hand's hole cards are withheld from the
   * public broadcast; the seat renders a Mucked label instead. Always false
   * for every live hand when an all-in ended further betting (spec section
   * 8: all-in showdown exposes every live hand, no muck option).
   */
  mucked?: boolean;
  /**
   * SHOWDOWN SYSTEM 2026-08-25: descriptive secondary line for the winning
   * hand display, e.g. "Kings Full Of Nines" under "Full House". Generated
   * by describeHand() from the actual evaluated hand.
   */
  handDescription?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Poker Engine Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatedHand {
  ranking: number;
  name: string;
  cards: Card[];
  kickers: number[];
}

export interface Pot {
  amount: number;
  eligiblePlayers: string[];
}

export interface BettingState {
  currentBet: number;
  minRaise: number;
  pot: number;
  toCall: number;
  /**
   * Bible V8 §4.14: Max raise SIZE — undefined for NL, pot+call for PL, and
   * the street's fixed bet for FL (where it equals minRaise, so the only legal
   * wager is exactly that size).
   */
  maxRaise?: number;
  /**
   * Fixed-limit only. True once the street has taken its bet and three raises
   * (BettingStructure.FIXED_LIMIT_MAX_WAGERS): no further bet or raise is
   * legal, only fold and call.
   */
  wagersCapped?: boolean;
  /** Which structure produced these bounds. Drives the rejection messages. */
  structure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
}

export interface RakeConfig {
  percent: number;
  cap: number;
  /** Bible V8 §2.9 / Appendix A: No rake if hand doesn't reach flop */
  noFlopNoDrop: boolean;
  /** Bible V8 §2.9: Rake caps by player count — e.g. [{players: 2, cap: 100}, {players: 5, cap: 200}] */
  playerCountCaps?: { players: number; cap: number }[];
  /** Bible V8 §2.9: Alternative timed rake (rake per time period instead of per pot) */
  timedRake?: { amountPerMinute: number };
}

export interface Winner {
  userId: string;
  amount: number;
  /** Bible V8 §2.7: Which pot (0 = main, 1+ = side pots) this win came from */
  potIndex?: number;
  hand?: EvaluatedHand;
}

/**
 * SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): one UNMERGED award record per
 * (pot, hi/lo half, winner). Winner[] merges a player's shares across pots —
 * the settlement contract — but the presentation layer needs to know which
 * pot each share came from to sequence "main pot… then side pot 1…" and to
 * label HIGH vs LOW winners on hi-lo boards. Amounts are post-rake display
 * shares (scaled + penny-repaired against the user's credited total in
 * HandController before WINNERS is emitted); board is set on double-board
 * hands.
 * Presentation data only — never used to move money.
 */
export interface PerPotAward {
  userId: string;
  potIndex: number;
  low: boolean;
  amount: number;
  hand?: EvaluatedHand;
  /** 1|2 on double-board bomb pots; RUN index 1..3 on run-it-twice hands. */
  board?: number;
  /**
   * Review fix 2026-08-25: the engine-generated description of THIS entry's
   * hand ("Kings Full Of Nines" / the low's name for low halves). Computed
   * where the hand is known, so board-2 groups no longer inherit board-1
   * showdown descriptions downstream.
   */
  handDescription?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Horse AI Types
// ─────────────────────────────────────────────────────────────────────────────

export type HorseStyle = 'tag' | 'lag' | 'balanced' | 'tricky' | 'grinder';

export interface HorseDecision {
  action: ActionType;
  amount?: number;
  thinkTime: number;
}

/** @deprecated Use HorseDecision */
export type BotDecision = HorseDecision;

export interface HorseGameState {
  players: SeatPlayer[];
  communityCards: Card[];
  /**
   * MULTI-BOARD EQUITY 2026-08-28 (Horses Are Players law): boards 2 and 3
   * of a multi-board bomb pot, empty otherwise. The brain averages per-board
   * equity — each board pays an equal share of every pot layer.
   */
  communityCards2?: Card[];
  communityCards3?: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  stage: HandStage;
  gameVariant: string;
  bigBlind: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tournament Types
// ─────────────────────────────────────────────────────────────────────────────

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

export type TournamentStatus =
  | 'ANNOUNCED'
  | 'REGISTERING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'LATE_REG';

// ─────────────────────────────────────────────────────────────────────────────
// Rake Distribution Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DealtInPlayer {
  userId: string;
  clubId: string;
  isSittingOut: boolean;
  hasCards: boolean;
  wentToFlop: boolean;
}
