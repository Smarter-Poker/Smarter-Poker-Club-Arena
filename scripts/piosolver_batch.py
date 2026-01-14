"""
PioSolver Batch Automation Script
Runs inside Windows VM to solve scenarios and push to Supabase
"""

import os
import subprocess
import json
import hashlib
from datetime import datetime
from supabase import create_client, Client
from typing import Dict, List, Optional
import time

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

PIOSOLVER_PATH = r"C:\Program Files\PioSOLVER\PioSOLVER3-pro.exe"
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TREE_FILES_DIR = r"C:\PioSolver\trees"
OUTPUT_DIR = r"C:\PioSolver\outputs"

# ═══════════════════════════════════════════════════════════════════════════════
# SUPABASE CLIENT
# ═══════════════════════════════════════════════════════════════════════════════

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO HASH
# ═══════════════════════════════════════════════════════════════════════════════

def compute_scenario_hash(
    position: str,
    pot_type: str, 
    street: str,
    board: List[str],
    action_facing: str,
    stack_depth: int = 100
) -> str:
    """Compute unique hash for a scenario"""
    raw = f"{position}|{pot_type}|{street}|{','.join(board or [])}|{action_facing}|{stack_depth}"
    return hashlib.md5(raw.encode()).hexdigest()

# ═══════════════════════════════════════════════════════════════════════════════
# PIOSOLVER RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

def run_solve(tree_file: str, output_file: str, accuracy: float = 0.5) -> Dict:
    """
    Run PioSolver on a tree file and return results
    
    Args:
        tree_file: Path to .txt tree configuration
        output_file: Path to save .cfr output
        accuracy: Target accuracy (lower = faster, higher = more precise)
    
    Returns:
        Dict with solve results and timing
    """
    start_time = time.time()
    
    # Build PioSolver command
    cmd = [
        PIOSOLVER_PATH,
        "solve", tree_file,
        "-o", output_file,
        "-a", str(accuracy),
        "-t", "4"  # Use 4 threads
    ]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600  # 1 hour max
        )
        
        solve_time = (time.time() - start_time) * 1000  # ms
        
        if result.returncode != 0:
            return {
                "success": False,
                "error": result.stderr,
                "solve_time_ms": solve_time
            }
        
        # Parse output file
        with open(output_file, 'r') as f:
            raw_output = f.read()
        
        return {
            "success": True,
            "raw_output": raw_output,
            "solve_time_ms": solve_time
        }
        
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "Solve timed out after 1 hour",
            "solve_time_ms": 3600000
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "solve_time_ms": 0
        }

# ═══════════════════════════════════════════════════════════════════════════════
# PARSE PIOSOLVER OUTPUT
# ═══════════════════════════════════════════════════════════════════════════════

def parse_gto_frequencies(raw_output: str) -> Dict:
    """
    Parse PioSolver CFR output to extract GTO frequencies
    
    Returns:
        Dict with action frequencies and EVs
    """
    # This is a simplified parser - actual Pio output is complex
    # Would need to parse the full .cfr format
    
    frequencies = {}
    ev_by_action = {}
    
    # Parse lines for action frequencies
    for line in raw_output.split('\n'):
        if 'fold' in line.lower():
            # Extract fold frequency
            pass
        elif 'call' in line.lower():
            # Extract call frequency
            pass
        elif 'raise' in line.lower():
            # Extract raise frequency
            pass
    
    return {
        "frequencies": frequencies,
        "ev_by_action": ev_by_action,
        "gto_action": max(frequencies, key=frequencies.get) if frequencies else "unknown"
    }

# ═══════════════════════════════════════════════════════════════════════════════
# QUEUE PROCESSOR
# ═══════════════════════════════════════════════════════════════════════════════

def process_queue():
    """
    Main loop: Pull from queue, solve, push results
    """
    print("🎯 PioSolver Batch Processor Started")
    print(f"📁 Tree files: {TREE_FILES_DIR}")
    print(f"📁 Output dir: {OUTPUT_DIR}")
    
    while True:
        # Get next pending scenario
        response = supabase.table("gto_solve_queue") \
            .select("*") \
            .eq("status", "pending") \
            .order("priority", desc=True) \
            .limit(1) \
            .execute()
        
        if not response.data:
            print("ℹ️ No pending scenarios. Waiting 30s...")
            time.sleep(30)
            continue
        
        scenario = response.data[0]
        scenario_id = scenario["id"]
        scenario_hash = scenario["scenario_hash"]
        
        print(f"🔄 Processing: {scenario_hash[:8]}...")
        
        # Mark as solving
        supabase.table("gto_solve_queue") \
            .update({"status": "solving", "started_at": datetime.utcnow().isoformat()}) \
            .eq("id", scenario_id) \
            .execute()
        
        try:
            # Build tree file path
            tree_file = os.path.join(TREE_FILES_DIR, f"{scenario_hash}.txt")
            output_file = os.path.join(OUTPUT_DIR, f"{scenario_hash}.cfr")
            
            # Run solve
            result = run_solve(tree_file, output_file)
            
            if result["success"]:
                # Parse results
                parsed = parse_gto_frequencies(result["raw_output"])
                
                # Insert into gto_solutions
                supabase.table("gto_solutions").upsert({
                    "scenario_hash": scenario_hash,
                    "position": scenario["position"],
                    "villain_position": scenario.get("villain_position"),
                    "stack_depth_bb": scenario["stack_depth_bb"],
                    "pot_type": scenario["pot_type"],
                    "street": scenario["street"],
                    "board": scenario.get("board"),
                    "action_facing": scenario.get("action_facing"),
                    "gto_action": parsed["gto_action"],
                    "gto_frequencies": parsed["frequencies"],
                    "ev_by_action": parsed["ev_by_action"],
                    "solve_time_ms": result["solve_time_ms"],
                    "solver_output": result["raw_output"][:10000],  # Truncate
                }).execute()
                
                # Mark queue item complete
                supabase.table("gto_solve_queue") \
                    .update({
                        "status": "completed",
                        "completed_at": datetime.utcnow().isoformat()
                    }) \
                    .eq("id", scenario_id) \
                    .execute()
                
                print(f"✅ Solved: {scenario_hash[:8]} ({result['solve_time_ms']:.0f}ms)")
                
            else:
                # Mark as failed
                supabase.table("gto_solve_queue") \
                    .update({
                        "status": "failed",
                        "error_message": result["error"],
                        "completed_at": datetime.utcnow().isoformat()
                    }) \
                    .eq("id", scenario_id) \
                    .execute()
                
                print(f"❌ Failed: {scenario_hash[:8]} - {result['error']}")
        
        except Exception as e:
            supabase.table("gto_solve_queue") \
                .update({
                    "status": "failed", 
                    "error_message": str(e),
                    "completed_at": datetime.utcnow().isoformat()
                }) \
                .eq("id", scenario_id) \
                .execute()
            print(f"❌ Error: {str(e)}")

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    process_queue()
