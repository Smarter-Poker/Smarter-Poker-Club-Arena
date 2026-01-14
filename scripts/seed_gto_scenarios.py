"""
GTO Scenario Queue Seeder with Round-Robin Bucket Rotation
Seeds scenarios from all formats equally - 100 per bucket, then rotate
"""

import os
import hashlib
from datetime import datetime
from typing import List, Dict
from supabase import create_client, Client

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════════

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://your-project.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "your-key")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

BATCH_SIZE = 100  # Hands per bucket before rotating

# ═══════════════════════════════════════════════════════════════════════════════
# BUCKET DEFINITIONS (All formats with priority weights)
# ═══════════════════════════════════════════════════════════════════════════════

BUCKETS = {
    # ═══════════════════════════════════════════════════════════════════
    # CASH GAMES - ALL BB DEPTHS (20, 40, 60, 80, 100, 200)
    # ═══════════════════════════════════════════════════════════════════
    
    # 6-MAX CASH (HIGHEST PRIORITY)
    "6max_cash_200bb": {"format": "6max_cash", "stack_depths": [200], "priority": 9, "target_count": 1000},
    "6max_cash_100bb": {"format": "6max_cash", "stack_depths": [100], "priority": 10, "target_count": 2000},
    "6max_cash_80bb": {"format": "6max_cash", "stack_depths": [80], "priority": 9, "target_count": 1000},
    "6max_cash_60bb": {"format": "6max_cash", "stack_depths": [60], "priority": 9, "target_count": 1000},
    "6max_cash_40bb": {"format": "6max_cash", "stack_depths": [40], "priority": 9, "target_count": 1000},
    "6max_cash_20bb": {"format": "6max_cash", "stack_depths": [20], "priority": 8, "target_count": 800},
    
    # HEADS UP CASH (HIGH PRIORITY)
    "hu_cash_200bb": {"format": "hu_cash", "stack_depths": [200], "priority": 8, "target_count": 800},
    "hu_cash_100bb": {"format": "hu_cash", "stack_depths": [100], "priority": 9, "target_count": 1000},
    "hu_cash_80bb": {"format": "hu_cash", "stack_depths": [80], "priority": 8, "target_count": 800},
    "hu_cash_60bb": {"format": "hu_cash", "stack_depths": [60], "priority": 8, "target_count": 800},
    "hu_cash_40bb": {"format": "hu_cash", "stack_depths": [40], "priority": 8, "target_count": 800},
    "hu_cash_20bb": {"format": "hu_cash", "stack_depths": [20], "priority": 7, "target_count": 600},
    
    # FULL RING (9-MAX) CASH
    "9max_cash_200bb": {"format": "9max_cash", "stack_depths": [200], "priority": 6, "target_count": 600},
    "9max_cash_100bb": {"format": "9max_cash", "stack_depths": [100], "priority": 7, "target_count": 800},
    "9max_cash_80bb": {"format": "9max_cash", "stack_depths": [80], "priority": 6, "target_count": 600},
    "9max_cash_60bb": {"format": "9max_cash", "stack_depths": [60], "priority": 6, "target_count": 600},
    "9max_cash_40bb": {"format": "9max_cash", "stack_depths": [40], "priority": 6, "target_count": 600},
    "9max_cash_20bb": {"format": "9max_cash", "stack_depths": [20], "priority": 5, "target_count": 400},
    
    # ═══════════════════════════════════════════════════════════════════
    # SPINS - ALL BB DEPTHS (8, 10, 12, 15, 18, 20, 25)
    # ═══════════════════════════════════════════════════════════════════
    
    # Spin 3-Max ChipEV
    "spin_3max_chipev_25bb": {"format": "spin_3max_chipev", "stack_depths": [25], "priority": 8, "target_count": 600},
    "spin_3max_chipev_20bb": {"format": "spin_3max_chipev", "stack_depths": [20], "priority": 9, "target_count": 800},
    "spin_3max_chipev_18bb": {"format": "spin_3max_chipev", "stack_depths": [18], "priority": 9, "target_count": 800},
    "spin_3max_chipev_15bb": {"format": "spin_3max_chipev", "stack_depths": [15], "priority": 10, "target_count": 1000},
    "spin_3max_chipev_12bb": {"format": "spin_3max_chipev", "stack_depths": [12], "priority": 10, "target_count": 1000},
    "spin_3max_chipev_10bb": {"format": "spin_3max_chipev", "stack_depths": [10], "priority": 9, "target_count": 800},
    "spin_3max_chipev_8bb": {"format": "spin_3max_chipev", "stack_depths": [8], "priority": 8, "target_count": 600},
    
    # Spin 3-Max ICM
    "spin_3max_icm_25bb": {"format": "spin_3max_icm", "stack_depths": [25], "priority": 8, "target_count": 600},
    "spin_3max_icm_20bb": {"format": "spin_3max_icm", "stack_depths": [20], "priority": 9, "target_count": 800},
    "spin_3max_icm_18bb": {"format": "spin_3max_icm", "stack_depths": [18], "priority": 9, "target_count": 800},
    "spin_3max_icm_15bb": {"format": "spin_3max_icm", "stack_depths": [15], "priority": 10, "target_count": 1000},
    "spin_3max_icm_12bb": {"format": "spin_3max_icm", "stack_depths": [12], "priority": 10, "target_count": 1000},
    "spin_3max_icm_10bb": {"format": "spin_3max_icm", "stack_depths": [10], "priority": 9, "target_count": 800},
    "spin_3max_icm_8bb": {"format": "spin_3max_icm", "stack_depths": [8], "priority": 8, "target_count": 600},
    
    # Spin HU
    "spin_hu_chipev_15bb": {"format": "spin_hu_chipev", "stack_depths": [15], "priority": 9, "target_count": 600},
    "spin_hu_chipev_10bb": {"format": "spin_hu_chipev", "stack_depths": [10], "priority": 9, "target_count": 600},
    "spin_hu_icm_15bb": {"format": "spin_hu_icm", "stack_depths": [15], "priority": 9, "target_count": 600},
    "spin_hu_icm_10bb": {"format": "spin_hu_icm", "stack_depths": [10], "priority": 9, "target_count": 600},
    
    # ═══════════════════════════════════════════════════════════════════
    # MTT 6-MAX - ALL BB DEPTHS (8, 10, 12, 15, 20, 25, 30, 40, 50)
    # ═══════════════════════════════════════════════════════════════════
    
    # MTT 6-Max ChipEV
    "mtt_6max_chipev_50bb": {"format": "mtt_6max_chipev", "stack_depths": [50], "priority": 7, "target_count": 600},
    "mtt_6max_chipev_40bb": {"format": "mtt_6max_chipev", "stack_depths": [40], "priority": 8, "target_count": 800},
    "mtt_6max_chipev_30bb": {"format": "mtt_6max_chipev", "stack_depths": [30], "priority": 9, "target_count": 1000},
    "mtt_6max_chipev_25bb": {"format": "mtt_6max_chipev", "stack_depths": [25], "priority": 9, "target_count": 1000},
    "mtt_6max_chipev_20bb": {"format": "mtt_6max_chipev", "stack_depths": [20], "priority": 10, "target_count": 1200},
    "mtt_6max_chipev_15bb": {"format": "mtt_6max_chipev", "stack_depths": [15], "priority": 10, "target_count": 1200},
    "mtt_6max_chipev_12bb": {"format": "mtt_6max_chipev", "stack_depths": [12], "priority": 9, "target_count": 1000},
    "mtt_6max_chipev_10bb": {"format": "mtt_6max_chipev", "stack_depths": [10], "priority": 9, "target_count": 1000},
    "mtt_6max_chipev_8bb": {"format": "mtt_6max_chipev", "stack_depths": [8], "priority": 8, "target_count": 800},
    
    # MTT 6-Max ICM
    "mtt_6max_icm_30bb": {"format": "mtt_6max_icm", "stack_depths": [30], "priority": 9, "target_count": 800},
    "mtt_6max_icm_25bb": {"format": "mtt_6max_icm", "stack_depths": [25], "priority": 10, "target_count": 1000},
    "mtt_6max_icm_20bb": {"format": "mtt_6max_icm", "stack_depths": [20], "priority": 10, "target_count": 1200},
    "mtt_6max_icm_15bb": {"format": "mtt_6max_icm", "stack_depths": [15], "priority": 10, "target_count": 1200},
    "mtt_6max_icm_12bb": {"format": "mtt_6max_icm", "stack_depths": [12], "priority": 9, "target_count": 1000},
    "mtt_6max_icm_10bb": {"format": "mtt_6max_icm", "stack_depths": [10], "priority": 9, "target_count": 1000},
    "mtt_6max_icm_8bb": {"format": "mtt_6max_icm", "stack_depths": [8], "priority": 8, "target_count": 800},
    
    # ═══════════════════════════════════════════════════════════════════
    # MTT 9-MAX - ALL BB DEPTHS
    # ═══════════════════════════════════════════════════════════════════
    
    # MTT 9-Max ChipEV
    "mtt_9max_chipev_50bb": {"format": "mtt_9max_chipev", "stack_depths": [50], "priority": 6, "target_count": 500},
    "mtt_9max_chipev_40bb": {"format": "mtt_9max_chipev", "stack_depths": [40], "priority": 7, "target_count": 600},
    "mtt_9max_chipev_30bb": {"format": "mtt_9max_chipev", "stack_depths": [30], "priority": 8, "target_count": 800},
    "mtt_9max_chipev_25bb": {"format": "mtt_9max_chipev", "stack_depths": [25], "priority": 8, "target_count": 800},
    "mtt_9max_chipev_20bb": {"format": "mtt_9max_chipev", "stack_depths": [20], "priority": 9, "target_count": 1000},
    "mtt_9max_chipev_15bb": {"format": "mtt_9max_chipev", "stack_depths": [15], "priority": 9, "target_count": 1000},
    "mtt_9max_chipev_10bb": {"format": "mtt_9max_chipev", "stack_depths": [10], "priority": 8, "target_count": 800},
    
    # MTT 9-Max ICM
    "mtt_9max_icm_25bb": {"format": "mtt_9max_icm", "stack_depths": [25], "priority": 9, "target_count": 800},
    "mtt_9max_icm_20bb": {"format": "mtt_9max_icm", "stack_depths": [20], "priority": 9, "target_count": 1000},
    "mtt_9max_icm_15bb": {"format": "mtt_9max_icm", "stack_depths": [15], "priority": 9, "target_count": 1000},
    "mtt_9max_icm_10bb": {"format": "mtt_9max_icm", "stack_depths": [10], "priority": 8, "target_count": 800},
    
    # ═══════════════════════════════════════════════════════════════════
    # MTT FINAL TABLE (3-Max, HU)
    # ═══════════════════════════════════════════════════════════════════
    
    "mtt_3max_chipev_25bb": {"format": "mtt_3max_chipev", "stack_depths": [25], "priority": 8, "target_count": 500},
    "mtt_3max_chipev_20bb": {"format": "mtt_3max_chipev", "stack_depths": [20], "priority": 9, "target_count": 600},
    "mtt_3max_chipev_15bb": {"format": "mtt_3max_chipev", "stack_depths": [15], "priority": 9, "target_count": 600},
    "mtt_3max_chipev_10bb": {"format": "mtt_3max_chipev", "stack_depths": [10], "priority": 8, "target_count": 500},
    
    "mtt_3max_icm_25bb": {"format": "mtt_3max_icm", "stack_depths": [25], "priority": 9, "target_count": 600},
    "mtt_3max_icm_20bb": {"format": "mtt_3max_icm", "stack_depths": [20], "priority": 10, "target_count": 800},
    "mtt_3max_icm_15bb": {"format": "mtt_3max_icm", "stack_depths": [15], "priority": 10, "target_count": 800},
    "mtt_3max_icm_10bb": {"format": "mtt_3max_icm", "stack_depths": [10], "priority": 9, "target_count": 600},
    
    "mtt_hu_chipev_25bb": {"format": "mtt_hu_chipev", "stack_depths": [25], "priority": 8, "target_count": 400},
    "mtt_hu_chipev_20bb": {"format": "mtt_hu_chipev", "stack_depths": [20], "priority": 8, "target_count": 400},
    "mtt_hu_chipev_15bb": {"format": "mtt_hu_chipev", "stack_depths": [15], "priority": 8, "target_count": 400},
    "mtt_hu_chipev_10bb": {"format": "mtt_hu_chipev", "stack_depths": [10], "priority": 8, "target_count": 400},
    
    "mtt_hu_icm_25bb": {"format": "mtt_hu_icm", "stack_depths": [25], "priority": 9, "target_count": 500},
    "mtt_hu_icm_20bb": {"format": "mtt_hu_icm", "stack_depths": [20], "priority": 9, "target_count": 500},
    "mtt_hu_icm_15bb": {"format": "mtt_hu_icm", "stack_depths": [15], "priority": 9, "target_count": 500},
    "mtt_hu_icm_10bb": {"format": "mtt_hu_icm", "stack_depths": [10], "priority": 8, "target_count": 400},
    
    # ═══════════════════════════════════════════════════════════════════
    # SNG - ALL BB DEPTHS
    # ═══════════════════════════════════════════════════════════════════
    
    # SNG 9-Max
    "sng_9max_chipev_30bb": {"format": "sng_9max_chipev", "stack_depths": [30], "priority": 6, "target_count": 400},
    "sng_9max_chipev_20bb": {"format": "sng_9max_chipev", "stack_depths": [20], "priority": 7, "target_count": 500},
    "sng_9max_chipev_15bb": {"format": "sng_9max_chipev", "stack_depths": [15], "priority": 7, "target_count": 500},
    "sng_9max_icm_25bb": {"format": "sng_9max_icm", "stack_depths": [25], "priority": 8, "target_count": 500},
    "sng_9max_icm_20bb": {"format": "sng_9max_icm", "stack_depths": [20], "priority": 8, "target_count": 600},
    "sng_9max_icm_15bb": {"format": "sng_9max_icm", "stack_depths": [15], "priority": 8, "target_count": 600},
    "sng_9max_icm_10bb": {"format": "sng_9max_icm", "stack_depths": [10], "priority": 7, "target_count": 500},
    
    # SNG 6-Max
    "sng_6max_icm_25bb": {"format": "sng_6max_icm", "stack_depths": [25], "priority": 7, "target_count": 400},
    "sng_6max_icm_20bb": {"format": "sng_6max_icm", "stack_depths": [20], "priority": 8, "target_count": 500},
    "sng_6max_icm_15bb": {"format": "sng_6max_icm", "stack_depths": [15], "priority": 8, "target_count": 500},
    "sng_6max_icm_10bb": {"format": "sng_6max_icm", "stack_depths": [10], "priority": 7, "target_count": 400},
    
    # SNG HU
    "sng_hu_25bb": {"format": "sng_hu", "stack_depths": [25], "priority": 7, "target_count": 300},
    "sng_hu_20bb": {"format": "sng_hu", "stack_depths": [20], "priority": 7, "target_count": 400},
    "sng_hu_15bb": {"format": "sng_hu", "stack_depths": [15], "priority": 7, "target_count": 400},
    "sng_hu_10bb": {"format": "sng_hu", "stack_depths": [10], "priority": 6, "target_count": 300},
}

# ═══════════════════════════════════════════════════════════════════════════════
# BOARD TEXTURES
# ═══════════════════════════════════════════════════════════════════════════════

BOARD_LIBRARY = [
    # Dry High
    "AsKd2c", "KsQc3d", "QhJd4c", "AhTc5d",
    # Dry Low
    "7s4d2c", "8c5d3s", "6h4c2d",
    # Wet Broadway
    "KsQdJc", "QcJdTh", "JsTc9d",
    # Wet Connected
    "9s8d7c", "8h7c6d", "7s6d5c",
    # Monotone
    "As9s4s", "Kh8h3h",
    # Paired
    "AsAd5c", "KsKc7d",
    # Two-tone
    "AsKd5s", "KhQc3h",
]

POSITIONS_BY_FORMAT = {
    "hu": [("BTN", "BB")],
    "3max": [("BTN", "BB"), ("BTN", "SB"), ("SB", "BB")],
    "6max": [
        ("BTN", "BB"), ("CO", "BB"), ("MP", "BB"), ("UTG", "BB"),
        ("BTN", "SB"), ("CO", "SB"),
    ],
    "9max": [
        ("BTN", "BB"), ("CO", "BB"), ("HJ", "BB"), ("MP", "BB"),
        ("UTG+2", "BB"), ("UTG+1", "BB"), ("UTG", "BB"),
    ],
}

POT_TYPES = ["srp", "3bet"]
ACTIONS = ["check", "bet_33", "bet_50"]

# ═══════════════════════════════════════════════════════════════════════════════
# HASH FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════

def compute_hash(format_code, hero, villain, pot_type, street, board, action, stack, is_icm):
    raw = f"{format_code}|{hero}|{villain}|{pot_type}|{street}|{board}|{action}|{stack}|{is_icm}"
    return hashlib.md5(raw.encode()).hexdigest()


# ═══════════════════════════════════════════════════════════════════════════════
# BUCKET STATUS TRACKER
# ═══════════════════════════════════════════════════════════════════════════════

class BucketTracker:
    def __init__(self):
        self.counts = {}  # bucket_name -> current count
        self.targets = {}  # bucket_name -> target count
        
    def load_from_db(self):
        """Load current solved counts from database"""
        for bucket_name, config in BUCKETS.items():
            # Count existing solutions for this bucket
            result = supabase.table("gto_solutions") \
                .select("id", count="exact") \
                .eq("format_code", config["format"]) \
                .in_("stack_depth_bb", config["stack_depths"]) \
                .execute()
            
            self.counts[bucket_name] = result.count or 0
            self.targets[bucket_name] = config["target_count"]
    
    def get_incomplete_buckets(self) -> List[str]:
        """Get buckets that haven't reached their target, sorted by priority"""
        incomplete = []
        for bucket_name in self.counts:
            if self.counts[bucket_name] < self.targets[bucket_name]:
                incomplete.append((bucket_name, BUCKETS[bucket_name]["priority"]))
        
        # Sort by priority (highest first)
        incomplete.sort(key=lambda x: -x[1])
        return [b[0] for b in incomplete]
    
    def increment(self, bucket_name):
        self.counts[bucket_name] = self.counts.get(bucket_name, 0) + 1


# ═══════════════════════════════════════════════════════════════════════════════
# ROUND-ROBIN QUEUE SEEDER
# ═══════════════════════════════════════════════════════════════════════════════

def generate_scenarios_for_bucket(bucket_name: str, count: int) -> List[Dict]:
    """Generate `count` scenarios for a specific bucket"""
    config = BUCKETS[bucket_name]
    format_code = config["format"]
    stack_depths = config["stack_depths"]
    is_icm = "icm" in format_code
    
    # Determine position pairs based on format
    if "hu" in format_code:
        positions = POSITIONS_BY_FORMAT["hu"]
    elif "3max" in format_code:
        positions = POSITIONS_BY_FORMAT["3max"]
    elif "6max" in format_code:
        positions = POSITIONS_BY_FORMAT["6max"]
    else:
        positions = POSITIONS_BY_FORMAT["9max"]
    
    scenarios = []
    idx = 0
    
    while len(scenarios) < count:
        # Rotate through all combinations
        stack = stack_depths[idx % len(stack_depths)]
        hero, villain = positions[idx % len(positions)]
        board = BOARD_LIBRARY[idx % len(BOARD_LIBRARY)]
        pot_type = POT_TYPES[idx % len(POT_TYPES)]
        action = ACTIONS[idx % len(ACTIONS)]
        
        scenario_hash = compute_hash(
            format_code, hero, villain, pot_type, "flop", board, action, stack, is_icm
        )
        
        scenarios.append({
            "scenario_hash": scenario_hash,
            "format_code": format_code,
            "hero_position": hero,
            "villain_position": villain,
            "pot_type": pot_type,
            "street": "flop",
            "board": list(board),  # Convert to array
            "action_facing": action,
            "stack_depth_bb": stack,
            "is_icm": is_icm,
            "priority": config["priority"],
            "status": "pending",
        })
        
        idx += 1
    
    return scenarios


def seed_round_robin():
    """
    Main seeding function - Round Robin approach
    Seeds BATCH_SIZE scenarios per bucket, rotates through all buckets
    """
    print("🎯 Round-Robin GTO Scenario Seeder")
    print(f"📦 Batch size: {BATCH_SIZE} per bucket")
    print(f"🪣 Total buckets: {len(BUCKETS)}")
    print("")
    
    tracker = BucketTracker()
    tracker.load_from_db()
    
    total_seeded = 0
    round_num = 0
    
    while True:
        incomplete = tracker.get_incomplete_buckets()
        
        if not incomplete:
            print("\n✅ All buckets complete!")
            break
        
        round_num += 1
        print(f"\n═══ Round {round_num} ═══")
        
        for bucket_name in incomplete:
            config = BUCKETS[bucket_name]
            current = tracker.counts[bucket_name]
            target = tracker.targets[bucket_name]
            remaining = target - current
            
            # Seed up to BATCH_SIZE or remaining, whichever is smaller
            to_seed = min(BATCH_SIZE, remaining)
            
            print(f"  🪣 {bucket_name}: {current}/{target} (+{to_seed})")
            
            scenarios = generate_scenarios_for_bucket(bucket_name, to_seed)
            
            # Insert to queue (skip duplicates)
            for scenario in scenarios:
                try:
                    supabase.table("gto_solve_queue").upsert(
                        scenario,
                        on_conflict="scenario_hash"
                    ).execute()
                    tracker.increment(bucket_name)
                    total_seeded += 1
                except Exception as e:
                    pass  # Skip duplicates
        
        # Progress summary
        print(f"\n  📊 Total seeded this round: {total_seeded}")
        
        # Safety limit - don't seed infinite scenarios
        if total_seeded > 50000:
            print("\n⚠️ Hit 50K limit, stopping.")
            break
    
    print(f"\n🎯 Seeding complete! Total: {total_seeded} scenarios queued")


def show_bucket_status():
    """Display current bucket completion status"""
    print("\n📊 Bucket Status")
    print("=" * 60)
    
    total_solved = 0
    total_target = 0
    
    for bucket_name, config in sorted(BUCKETS.items(), key=lambda x: -x[1]["priority"]):
        result = supabase.table("gto_solutions") \
            .select("id", count="exact") \
            .eq("format_code", config["format"]) \
            .in_("stack_depth_bb", config["stack_depths"]) \
            .execute()
        
        solved = result.count or 0
        target = config["target_count"]
        pct = (solved / target * 100) if target > 0 else 0
        
        bar_len = 20
        filled = int(bar_len * pct / 100)
        bar = "█" * filled + "░" * (bar_len - filled)
        
        status = "✅" if pct >= 100 else "🔄" if pct > 0 else "⏳"
        print(f"{status} {bucket_name:25} [{bar}] {solved:5}/{target:5} ({pct:5.1f}%)")
        
        total_solved += solved
        total_target += target
    
    print("=" * 60)
    pct = (total_solved / total_target * 100) if total_target > 0 else 0
    print(f"   TOTAL: {total_solved}/{total_target} ({pct:.1f}%)")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        show_bucket_status()
    else:
        seed_round_robin()
