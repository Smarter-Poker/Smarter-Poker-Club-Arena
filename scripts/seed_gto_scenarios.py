"""
Seed GTO Scenarios to Supabase
Populates the solve queue with priority scenarios
"""

import os
import hashlib
from datetime import datetime
from supabase import create_client, Client

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG - Set these environment variables
# ═══════════════════════════════════════════════════════════════════════════════

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://xyzcompanyref.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "your-service-role-key")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════════

def compute_hash(position, pot_type, street, board, action_facing, stack_depth):
    raw = f"{position}|{pot_type}|{street}|{','.join(board or [])}|{action_facing}|{stack_depth}"
    return hashlib.md5(raw.encode()).hexdigest()


# Priority scenarios to queue for solving
PRIORITY_SCENARIOS = [
    # BTN vs BB SRP - Flop spots (most common)
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["As", "Kd", "2c"], "action": "check", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["As", "Kd", "2c"], "action": "bet_33", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["7s", "4d", "2c"], "action": "check", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["7s", "4d", "2c"], "action": "bet_33", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["9s", "8d", "7c"], "action": "check", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["Ks", "Qd", "Jc"], "action": "check", "stack": 100, "priority": 10},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["As", "5s", "4s"], "action": "check", "stack": 100, "priority": 9},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["Qh", "Jd", "4c"], "action": "check", "stack": 100, "priority": 9},
    
    # CO vs BB SRP
    {"position": "CO", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["As", "Kd", "2c"], "action": "check", "stack": 100, "priority": 8},
    {"position": "CO", "villain": "BB", "pot_type": "srp", "street": "flop", "board": ["7s", "4d", "2c"], "action": "check", "stack": 100, "priority": 8},
    
    # 3bet pots
    {"position": "BTN", "villain": "BB", "pot_type": "3bet", "street": "flop", "board": ["As", "Kd", "2c"], "action": "check", "stack": 100, "priority": 7},
    {"position": "BTN", "villain": "BB", "pot_type": "3bet", "street": "flop", "board": ["Ks", "Qd", "Jc"], "action": "check", "stack": 100, "priority": 7},
    
    # Turn spots (after flop bet/call)
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "turn", "board": ["As", "Kd", "2c", "7h"], "action": "check", "stack": 100, "priority": 6},
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "turn", "board": ["7s", "4d", "2c", "Ks"], "action": "check", "stack": 100, "priority": 6},
    
    # River spots
    {"position": "BTN", "villain": "BB", "pot_type": "srp", "street": "river", "board": ["As", "Kd", "2c", "7h", "3d"], "action": "check", "stack": 100, "priority": 5},
]


def seed_scenarios():
    """Push all priority scenarios to the solve queue"""
    print("🎯 Seeding GTO Scenarios to Supabase...")
    
    for scenario in PRIORITY_SCENARIOS:
        scenario_hash = compute_hash(
            scenario["position"],
            scenario["pot_type"],
            scenario["street"],
            scenario["board"],
            scenario["action"],
            scenario["stack"]
        )
        
        # Check if already exists
        existing = supabase.table("gto_solve_queue") \
            .select("id") \
            .eq("scenario_hash", scenario_hash) \
            .execute()
        
        if existing.data:
            print(f"⏭️  Already queued: {scenario_hash[:8]}")
            continue
        
        # Insert to queue
        supabase.table("gto_solve_queue").insert({
            "scenario_hash": scenario_hash,
            "position": scenario["position"],
            "villain_position": scenario.get("villain"),
            "pot_type": scenario["pot_type"],
            "street": scenario["street"],
            "board": scenario["board"],
            "action_facing": scenario["action"],
            "stack_depth_bb": scenario["stack"],
            "priority": scenario["priority"],
            "status": "pending"
        }).execute()
        
        print(f"✅ Queued: {scenario['position']} vs {scenario['villain']} | {scenario['pot_type']} | {''.join(scenario['board'])}")
    
    print(f"\n🎯 Seeded {len(PRIORITY_SCENARIOS)} scenarios to solve queue")


def check_queue_status():
    """Check current queue status"""
    result = supabase.table("gto_solve_queue") \
        .select("status") \
        .execute()
    
    if not result.data:
        print("📭 Queue is empty")
        return
    
    statuses = {}
    for row in result.data:
        status = row["status"]
        statuses[status] = statuses.get(status, 0) + 1
    
    print("\n📊 Queue Status:")
    for status, count in statuses.items():
        emoji = {"pending": "⏳", "solving": "🔄", "completed": "✅", "failed": "❌"}.get(status, "❓")
        print(f"   {emoji} {status}: {count}")


if __name__ == "__main__":
    seed_scenarios()
    check_queue_status()
