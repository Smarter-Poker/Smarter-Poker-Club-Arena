"""
Complete PioSolver Tree Generator
Generates tree files for all game formats:
- Cash: HU, 6-Max, Full Ring
- MTT: Chip EV + ICM, all table sizes
- SNG: All variants
- Spins: 3-Max Hyper Turbo
"""

import os
import hashlib
from dataclasses import dataclass
from typing import List, Dict, Optional
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════════
# GAME FORMAT CONFIGURATIONS
# ═══════════════════════════════════════════════════════════════════════════════

GAME_FORMATS = {
    # Cash Games
    "hu_cash": {
        "name": "Heads Up Cash",
        "category": "cash",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [20, 50, 100, 200],
        "uses_icm": False,
    },
    "6max_cash": {
        "name": "6-Max Cash",
        "category": "cash",
        "players": 6,
        "positions": ["UTG", "MP", "CO", "BTN", "SB", "BB"],
        "stack_depths": [20, 50, 100, 200],
        "uses_icm": False,
    },
    "9max_cash": {
        "name": "Full Ring Cash",
        "category": "cash",
        "players": 9,
        "positions": ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO", "BTN", "SB", "BB"],
        "stack_depths": [50, 100],
        "uses_icm": False,
    },
    
    # MTT (Multi-Table Tournaments)
    "mtt_9max_chipev": {
        "name": "MTT 9-Max Chip EV",
        "category": "mtt",
        "players": 9,
        "positions": ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25, 30, 40, 50],
        "uses_icm": False,
    },
    "mtt_9max_icm": {
        "name": "MTT 9-Max ICM",
        "category": "mtt",
        "players": 9,
        "positions": ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25, 30],
        "uses_icm": True,
    },
    "mtt_6max_chipev": {
        "name": "MTT 6-Max Chip EV",
        "category": "mtt",
        "players": 6,
        "positions": ["UTG", "MP", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25, 30, 40, 50],
        "uses_icm": False,
    },
    "mtt_6max_icm": {
        "name": "MTT 6-Max ICM",
        "category": "mtt",
        "players": 6,
        "positions": ["UTG", "MP", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25, 30],
        "uses_icm": True,
    },
    "mtt_3max_chipev": {
        "name": "MTT 3-Max Chip EV",
        "category": "mtt",
        "players": 3,
        "positions": ["BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25, 30],
        "uses_icm": False,
    },
    "mtt_3max_icm": {
        "name": "MTT 3-Max ICM (Final Table)",
        "category": "mtt",
        "players": 3,
        "positions": ["BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25],
        "uses_icm": True,
    },
    "mtt_hu_chipev": {
        "name": "MTT Heads Up Chip EV",
        "category": "mtt",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [10, 15, 20, 25, 30, 40],
        "uses_icm": False,
    },
    "mtt_hu_icm": {
        "name": "MTT Heads Up ICM",
        "category": "mtt",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [10, 15, 20, 25],
        "uses_icm": True,
    },
    
    # SNG (Sit & Go)
    "sng_9max_chipev": {
        "name": "SNG 9-Max Chip EV",
        "category": "sng",
        "players": 9,
        "positions": ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO", "BTN", "SB", "BB"],
        "stack_depths": [15, 20, 25, 30],
        "uses_icm": False,
    },
    "sng_9max_icm": {
        "name": "SNG 9-Max ICM",
        "category": "sng",
        "players": 9,
        "positions": ["UTG", "UTG+1", "UTG+2", "MP", "MP+1", "HJ", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25],
        "uses_icm": True,
    },
    "sng_6max_icm": {
        "name": "SNG 6-Max ICM",
        "category": "sng",
        "players": 6,
        "positions": ["UTG", "MP", "CO", "BTN", "SB", "BB"],
        "stack_depths": [10, 15, 20, 25],
        "uses_icm": True,
    },
    "sng_hu": {
        "name": "SNG Heads Up",
        "category": "sng",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [10, 15, 20, 25, 30],
        "uses_icm": False,
    },
    
    # Spins (3-Max Hyper Turbo)
    "spin_3max_chipev": {
        "name": "Spin 3-Max Chip EV",
        "category": "spin",
        "players": 3,
        "positions": ["BTN", "SB", "BB"],
        "stack_depths": [8, 10, 12, 15, 18, 20, 25],
        "uses_icm": False,
    },
    "spin_3max_icm": {
        "name": "Spin 3-Max ICM",
        "category": "spin",
        "players": 3,
        "positions": ["BTN", "SB", "BB"],
        "stack_depths": [8, 10, 12, 15, 18, 20],
        "uses_icm": True,
    },
    "spin_hu_chipev": {
        "name": "Spin HU Chip EV",
        "category": "spin",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [8, 10, 12, 15, 18, 20, 25],
        "uses_icm": False,
    },
    "spin_hu_icm": {
        "name": "Spin HU ICM",
        "category": "spin",
        "players": 2,
        "positions": ["BTN", "BB"],
        "stack_depths": [8, 10, 12, 15],
        "uses_icm": True,
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
# PREFLOP RANGES BY FORMAT
# ═══════════════════════════════════════════════════════════════════════════════

RANGES = {
    # 6-Max Cash 100bb
    "6max_cash": {
        "UTG_rfi": "77+,A9s+,KTs+,QTs+,JTs,T9s,98s,87s,76s,AJo+,KQo",
        "MP_rfi": "66+,A5s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo",
        "CO_rfi": "55+,A2s+,K5s+,Q7s+,J8s+,T8s+,97s+,86s+,75s+,65s,54s,A9o+,KTo+,QTo+,JTo",
        "BTN_rfi": "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o,87o",
        "SB_rfi": "22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A2o+,K7o+,Q9o+,J9o+,T9o",
        "BB_defend": "22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,86s+,75s+,65s,54s,43s,A2o+,K5o+,Q7o+,J8o+,T8o+,98o,87o",
    },
    
    # MTT - Tighter ranges due to tournament dynamics
    "mtt_default": {
        "UTG_rfi": "88+,ATs+,KQs,AJo+,KQo",
        "MP_rfi": "77+,A9s+,KJs+,QJs,JTs,ATo+,KQo",
        "CO_rfi": "66+,A5s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,A9o+,KTo+,QJo",
        "BTN_rfi": "44+,A2s+,K7s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,A7o+,K9o+,QTo+,JTo",
        "SB_rfi": "55+,A2s+,K8s+,Q9s+,J9s+,T9s,98s,87s,76s,A8o+,KTo+,QJo",
    },
    
    # Spin - Very aggressive 3-max
    "spin_default": {
        "BTN_rfi": "22+,A2s+,K2s+,Q2s+,J5s+,T6s+,96s+,86s+,76s,65s,54s,A2o+,K4o+,Q7o+,J8o+,T8o+,98o",
        "SB_rfi": "22+,A2s+,K2s+,Q4s+,J7s+,T7s+,97s+,87s,76s,65s,A2o+,K6o+,Q8o+,J9o+,T9o",
    },
    
    # HU - Wide ranges
    "hu_default": {
        "BTN_rfi": "22+,A2s+,K2s+,Q2s+,J2s+,T4s+,95s+,85s+,74s+,64s+,54s,43s,A2o+,K2o+,Q4o+,J6o+,T7o+,97o+,87o,76o",
        "BB_defend": "22+,A2s+,K2s+,Q2s+,J2s+,T2s+,94s+,84s+,74s+,64s+,53s+,43s,A2o+,K2o+,Q3o+,J5o+,T6o+,96o+,86o+,76o,65o",
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
# BOARD TEXTURES
# ═══════════════════════════════════════════════════════════════════════════════

BOARD_TEXTURES = {
    "dry_high": ["AsKd2c", "KsQc3d", "QhJd4c", "AhTc5d", "KsJd2c"],
    "dry_mid": ["9s7d2c", "Tc6d3h", "8h5c2d", "7s4d2h", "9h3c2d"],
    "dry_low": ["7s4d2c", "6c3d2s", "5s4d2h", "8c5d2s", "6h4c2d"],
    "wet_broadway": ["KsQdJc", "AhKdQc", "QcJdTh", "JsTc9d", "KhQcTd"],
    "wet_connected": ["9s8d7c", "Tc9h8d", "8h7c6d", "7s6d5c", "6h5c4d"],
    "monotone_high": ["As9s4s", "Kh8h3h", "Qc7c2c", "KsTs5s", "AhJh6h"],
    "monotone_low": ["9s5s2s", "8h4h2h", "7c3c2c", "6d4d2d", "9c6c3c"],
    "paired_high": ["AsAd5c", "KsKc7d", "QhQc4d", "JsJd3c", "TsTd6c"],
    "paired_low": ["5s5c2h", "4h4c7d", "3s3d8c", "2h2c9d", "6s6c3d"],
    "two_tone_high": ["AsKd5s", "KhQc3h", "QsJd7s", "AcTh4c", "KsQd8s"],
    "two_tone_low": ["7s4d7c", "8h5c3h", "6s3d2s", "9h6c4h", "5s2d8s"],
}

# ═══════════════════════════════════════════════════════════════════════════════
# BETTING LINES BY FORMAT
# ═══════════════════════════════════════════════════════════════════════════════

BET_LINES = {
    "cash_deep": {
        "flop": ["check", "bet:25", "bet:33", "bet:50", "bet:75", "bet:100"],
        "turn": ["check", "bet:33", "bet:50", "bet:75", "bet:100"],
        "river": ["check", "bet:50", "bet:75", "bet:100", "bet:150", "allin"],
    },
    "mtt_mid": {
        "flop": ["check", "bet:33", "bet:50", "bet:75"],
        "turn": ["check", "bet:50", "bet:75", "allin"],
        "river": ["check", "bet:50", "bet:75", "allin"],
    },
    "spin_shallow": {
        "flop": ["check", "bet:33", "bet:50", "allin"],
        "turn": ["check", "bet:50", "allin"],
        "river": ["check", "allin"],
    },
}

# ═══════════════════════════════════════════════════════════════════════════════
# TREE GENERATOR
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class TreeConfig:
    format_code: str
    hero_pos: str
    villain_pos: str
    stack_bb: int
    pot_type: str
    street: str
    board: str
    is_icm: bool = False
    icm_payouts: List[int] = None


def compute_hash(config: TreeConfig) -> str:
    raw = f"{config.format_code}|{config.hero_pos}|{config.pot_type}|{config.street}|{config.board}|{config.stack_bb}|{config.is_icm}"
    return hashlib.md5(raw.encode()).hexdigest()


def get_range(format_code: str, position: str, action: str) -> str:
    """Get appropriate range for format and position"""
    range_key = f"{position}_{action}"
    
    # Try format-specific first
    if format_code in RANGES and range_key in RANGES[format_code]:
        return RANGES[format_code][range_key]
    
    # Fall back to category defaults
    category = GAME_FORMATS.get(format_code, {}).get("category", "cash")
    if category == "spin":
        return RANGES.get("spin_default", {}).get(range_key, "")
    elif category in ["mtt", "sng"]:
        return RANGES.get("mtt_default", {}).get(range_key, "")
    elif GAME_FORMATS.get(format_code, {}).get("players") == 2:
        return RANGES.get("hu_default", {}).get(range_key, "")
    else:
        return RANGES.get("6max_cash", {}).get(range_key, "")


def get_bet_lines(format_code: str, stack_bb: int) -> Dict:
    """Get appropriate bet lines for format and stack"""
    category = GAME_FORMATS.get(format_code, {}).get("category", "cash")
    
    if category == "spin" or stack_bb <= 20:
        return BET_LINES["spin_shallow"]
    elif category in ["mtt", "sng"]:
        return BET_LINES["mtt_mid"]
    else:
        return BET_LINES["cash_deep"]


def generate_tree_file(config: TreeConfig) -> str:
    """Generate PioSolver tree file content"""
    
    format_info = GAME_FORMATS.get(config.format_code, {})
    bet_lines = get_bet_lines(config.format_code, config.stack_bb)
    
    # Calculate pot and effective stack based on pot type
    if config.pot_type == "srp":
        pot = 6.5 if config.stack_bb >= 50 else 5.0
        eff_stack = config.stack_bb - 2.5
    elif config.pot_type == "3bet":
        pot = 22.0 if config.stack_bb >= 50 else 15.0
        eff_stack = config.stack_bb - 10
    else:
        pot = 2.5
        eff_stack = config.stack_bb - 1
    
    hero_range = get_range(config.format_code, config.hero_pos, "rfi")
    villain_range = get_range(config.format_code, config.villain_pos, "defend")
    
    lines = [
        f"# ═══════════════════════════════════════════════════════════════",
        f"# PioSolver Tree File",
        f"# Format: {format_info.get('name', config.format_code)}",
        f"# Scenario: {config.hero_pos} vs {config.villain_pos} | {config.pot_type.upper()} | {config.street}",
        f"# Stack: {config.stack_bb}bb | ICM: {config.is_icm}",
        f"# Generated: {datetime.now().isoformat()}",
        f"# ═══════════════════════════════════════════════════════════════",
        "",
        f"set_board {config.board}",
        f"set_pot {pot}",
        f"set_effective_stack {eff_stack}",
        "",
    ]
    
    # ICM settings
    if config.is_icm and config.icm_payouts:
        lines.extend([
            "# ICM Configuration",
            f"set_icm true",
            f"set_payouts {','.join(map(str, config.icm_payouts))}",
            "",
        ])
    
    # Ranges
    lines.extend([
        "# Ranges",
        f"set_range OOP {villain_range if config.villain_pos in ['BB', 'SB'] else hero_range}",
        f"set_range IP {hero_range if config.hero_pos in ['BTN', 'CO', 'MP'] else villain_range}",
        "",
        "# Betting Lines",
    ])
    
    # Add betting lines
    street_lines = bet_lines.get(config.street, bet_lines.get("flop", []))
    for action in street_lines:
        if action == "check":
            lines.append("add_line OOP:check")
            lines.append("add_line OOP:check IP:check")
            for ip_action in street_lines:
                if ip_action != "check":
                    lines.append(f"add_line OOP:check IP:{ip_action}")
        elif action.startswith("bet:") or action == "allin":
            lines.append(f"add_line OOP:{action}")
    
    lines.extend([
        "",
        "# Solver Settings",
        "set_accuracy 0.5",
        "set_max_iterations 1000000",
        "",
        "build_tree",
        "# go  # Uncomment to start solving",
    ])
    
    return "\n".join(lines)


def generate_all_trees(output_dir: str = "./trees"):
    """Generate tree files for all formats and configurations"""
    os.makedirs(output_dir, exist_ok=True)
    
    total_generated = 0
    
    for format_code, format_info in GAME_FORMATS.items():
        format_dir = os.path.join(output_dir, format_code)
        os.makedirs(format_dir, exist_ok=True)
        
        positions = format_info["positions"]
        stack_depths = format_info["stack_depths"]
        uses_icm = format_info["uses_icm"]
        
        # Generate for each position matchup
        for i, hero_pos in enumerate(positions):
            for villain_pos in positions[i+1:]:  # Avoid duplicates
                for stack_bb in stack_depths:
                    # Flop SRP
                    for texture_name, boards in BOARD_TEXTURES.items():
                        for board in boards[:2]:  # First 2 boards per texture
                            config = TreeConfig(
                                format_code=format_code,
                                hero_pos=hero_pos,
                                villain_pos=villain_pos,
                                stack_bb=stack_bb,
                                pot_type="srp",
                                street="flop",
                                board=board,
                                is_icm=uses_icm,
                                icm_payouts=[50, 30, 20] if uses_icm else None
                            )
                            
                            filename = f"{hero_pos}_vs_{villain_pos}_{stack_bb}bb_{texture_name}_{board}.txt"
                            filepath = os.path.join(format_dir, filename)
                            
                            content = generate_tree_file(config)
                            with open(filepath, 'w') as f:
                                f.write(content)
                            
                            total_generated += 1
        
        print(f"✅ {format_code}: Generated trees in {format_dir}")
    
    print(f"\n🎯 Total: {total_generated} tree files generated")
    return total_generated


if __name__ == "__main__":
    generate_all_trees("./trees")
