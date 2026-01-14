"""
PioSolver Batch Runner - Windows
Runs on Windows PC to solve GTO scenarios from Supabase queue

Usage:
    python piosolver_batch_runner.py

Environment Variables (set in .env):
    SUPABASE_URL - Your Supabase project URL
    SUPABASE_SERVICE_KEY - Service role key for write access
    PIOSOLVER_PATH - Path to PioSolver executable
"""

import os
import subprocess
import json
import hashlib
import time
from datetime import datetime
from typing import Dict, List, Optional
from pathlib import Path

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

from supabase import create_client, Client

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

PIOSOLVER_PATH = os.environ.get("PIOSOLVER_PATH", r"C:\Program Files\PioSOLVER\PioSOLVER3-pro.exe")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TREE_FILES_DIR = Path(os.environ.get("TREE_FILES_DIR", r"C:\PioSolver\trees"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", r"C:\PioSolver\outputs"))
SOLVER_ACCURACY = float(os.environ.get("SOLVER_ACCURACY", "0.5"))
SOLVER_THREADS = int(os.environ.get("SOLVER_THREADS", "4"))
MAX_SOLVE_TIME = int(os.environ.get("MAX_SOLVE_TIME_HOURS", "1")) * 3600

# ═══════════════════════════════════════════════════════════════════════════════
# SUPABASE CLIENT
# ═══════════════════════════════════════════════════════════════════════════════

def init_supabase() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

supabase: Client = None

# ═══════════════════════════════════════════════════════════════════════════════
# TREE FILE GENERATOR
# ═══════════════════════════════════════════════════════════════════════════════

def generate_tree_file(scenario: Dict) -> str:
    """Generate PioSolver tree file content from scenario data"""
    
    position = scenario.get("position", "BTN")
    villain_pos = scenario.get("villain_position", "BB")
    stack_bb = scenario.get("stack_depth_bb", 100)
    pot_type = scenario.get("pot_type", "srp")
    street = scenario.get("street", "flop")
    board = scenario.get("board", ["As", "Kd", "5c"])
    
    # Calculate pot and stacks
    if pot_type == "srp":
        pot = 6.5 if stack_bb >= 50 else 5.0
        eff_stack = stack_bb - 2.5
    elif pot_type == "3bet":
        pot = 22.0 if stack_bb >= 50 else 15.0
        eff_stack = stack_bb - 10
    else:
        pot = 2.5
        eff_stack = stack_bb - 1
    
    board_str = "".join(board) if isinstance(board, list) else board
    
    lines = [
        f"# PioSolver Tree - Auto Generated",
        f"# Scenario: {position} vs {villain_pos} | {pot_type} | {street}",
        f"# Stack: {stack_bb}bb | Board: {board_str}",
        f"# Generated: {datetime.now().isoformat()}",
        "",
        f"set_board {board_str}",
        f"set_pot {pot}",
        f"set_effective_stack {eff_stack}",
        "",
        "# Default ranges (simplified)",
        "set_range OOP 22+,A2s+,K5s+,Q8s+,J9s+,T9s,98s,87s,76s,A7o+,K9o+,QTo+,JTo",
        "set_range IP 22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A2o+,K7o+,Q9o+,J9o+,T9o",
        "",
        "# Betting lines",
        "add_line OOP:check",
        "add_line OOP:check IP:check",
        "add_line OOP:check IP:bet:33",
        "add_line OOP:check IP:bet:50",
        "add_line OOP:check IP:bet:75",
        "add_line OOP:bet:33",
        "add_line OOP:bet:50",
        "add_line OOP:bet:75",
        "",
        "# Solver settings",
        f"set_accuracy {SOLVER_ACCURACY}",
        "set_max_iterations 500000",
        "",
        "build_tree",
        "go",
    ]
    
    return "\n".join(lines)

# ═══════════════════════════════════════════════════════════════════════════════
# PIOSOLVER EXECUTION
# ═══════════════════════════════════════════════════════════════════════════════

def run_piosolver(tree_file: Path, output_file: Path) -> Dict:
    """Execute PioSolver on a tree file"""
    
    if not os.path.exists(PIOSOLVER_PATH):
        return {"success": False, "error": f"PioSolver not found at {PIOSOLVER_PATH}"}
    
    start_time = time.time()
    
    # PioSolver 3 uses a different command structure
    # The tree file already contains the 'go' command to start solving
    cmd = [
        PIOSOLVER_PATH,
        "-script", str(tree_file),
        "-o", str(output_file),
    ]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=MAX_SOLVE_TIME,
            cwd=str(tree_file.parent)
        )
        
        solve_time = (time.time() - start_time) * 1000
        
        if result.returncode != 0:
            return {
                "success": False,
                "error": result.stderr or result.stdout,
                "solve_time_ms": solve_time
            }
        
        # Read output if exists
        raw_output = ""
        if output_file.exists():
            raw_output = output_file.read_text()[:50000]  # Limit size
        
        return {
            "success": True,
            "raw_output": raw_output,
            "stdout": result.stdout,
            "solve_time_ms": solve_time
        }
        
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": f"Timeout after {MAX_SOLVE_TIME}s",
            "solve_time_ms": MAX_SOLVE_TIME * 1000
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "solve_time_ms": 0
        }

# ═══════════════════════════════════════════════════════════════════════════════
# PARSE GTO OUTPUT
# ═══════════════════════════════════════════════════════════════════════════════

def parse_gto_frequencies(raw_output: str) -> Dict:
    """Parse PioSolver output to extract GTO frequencies"""
    
    # Simplified parser - actual Pio output is complex CFR format
    frequencies = {"fold": 0.0, "call": 0.0, "raise": 0.0}
    ev_by_action = {}
    
    # Parse for frequency lines
    lines = raw_output.split('\n')
    for line in lines:
        line_lower = line.lower()
        if 'fold' in line_lower and '%' in line:
            try:
                freq = float(line.split('%')[0].split()[-1]) / 100
                frequencies['fold'] = freq
            except:
                pass
        elif 'call' in line_lower and '%' in line:
            try:
                freq = float(line.split('%')[0].split()[-1]) / 100
                frequencies['call'] = freq
            except:
                pass
        elif 'raise' in line_lower and '%' in line:
            try:
                freq = float(line.split('%')[0].split()[-1]) / 100
                frequencies['raise'] = freq
            except:
                pass
    
    # Determine primary GTO action
    if frequencies:
        gto_action = max(frequencies, key=frequencies.get)
    else:
        gto_action = "unknown"
    
    return {
        "frequencies": frequencies,
        "ev_by_action": ev_by_action,
        "gto_action": gto_action
    }

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN QUEUE PROCESSOR
# ═══════════════════════════════════════════════════════════════════════════════

def process_queue():
    """Main loop: Pull from Supabase queue, solve, push results"""
    
    global supabase
    supabase = init_supabase()
    
    # Ensure directories exist
    TREE_FILES_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    print("=" * 60)
    print("🎯 PioSolver Batch Processor Started")
    print("=" * 60)
    print(f"📁 Tree files: {TREE_FILES_DIR}")
    print(f"📁 Output dir: {OUTPUT_DIR}")
    print(f"🔧 Solver: {PIOSOLVER_PATH}")
    print(f"🎯 Accuracy: {SOLVER_ACCURACY}")
    print(f"⚙️ Threads: {SOLVER_THREADS}")
    print()
    
    solved_count = 0
    
    while True:
        try:
            # Get next pending scenario
            response = supabase.table("gto_solve_queue") \
                .select("*") \
                .eq("status", "pending") \
                .order("priority", desc=True) \
                .limit(1) \
                .execute()
            
            if not response.data:
                print(f"ℹ️ No pending scenarios. Solved {solved_count} so far. Waiting 30s...")
                time.sleep(30)
                continue
            
            scenario = response.data[0]
            scenario_id = scenario["id"]
            scenario_hash = scenario["scenario_hash"]
            
            print(f"\n🔄 Processing: {scenario_hash[:12]}...")
            print(f"   Position: {scenario.get('position')} vs {scenario.get('villain_position')}")
            print(f"   Stack: {scenario.get('stack_depth_bb')}bb | {scenario.get('pot_type')} | {scenario.get('street')}")
            
            # Mark as solving
            supabase.table("gto_solve_queue") \
                .update({
                    "status": "solving",
                    "started_at": datetime.utcnow().isoformat()
                }) \
                .eq("id", scenario_id) \
                .execute()
            
            # Generate tree file
            tree_content = generate_tree_file(scenario)
            tree_file = TREE_FILES_DIR / f"{scenario_hash}.txt"
            output_file = OUTPUT_DIR / f"{scenario_hash}.cfr"
            
            tree_file.write_text(tree_content)
            print(f"   📄 Tree file: {tree_file.name}")
            
            # Run solver
            result = run_piosolver(tree_file, output_file)
            
            if result["success"]:
                # Parse results
                parsed = parse_gto_frequencies(result.get("raw_output", ""))
                
                # Insert into gto_solutions
                supabase.table("gto_solutions").upsert({
                    "scenario_hash": scenario_hash,
                    "position": scenario.get("position"),
                    "villain_position": scenario.get("villain_position"),
                    "stack_depth_bb": scenario.get("stack_depth_bb"),
                    "pot_type": scenario.get("pot_type"),
                    "street": scenario.get("street"),
                    "board": scenario.get("board"),
                    "action_facing": scenario.get("action_facing"),
                    "gto_action": parsed["gto_action"],
                    "gto_frequencies": parsed["frequencies"],
                    "ev_by_action": parsed["ev_by_action"],
                    "solve_time_ms": int(result["solve_time_ms"]),
                    "solver_output": result.get("raw_output", "")[:10000],
                }).execute()
                
                # Mark complete
                supabase.table("gto_solve_queue") \
                    .update({
                        "status": "completed",
                        "completed_at": datetime.utcnow().isoformat()
                    }) \
                    .eq("id", scenario_id) \
                    .execute()
                
                solved_count += 1
                print(f"   ✅ Solved! ({result['solve_time_ms']:.0f}ms) - GTO: {parsed['gto_action']}")
                
            else:
                # Mark as failed
                supabase.table("gto_solve_queue") \
                    .update({
                        "status": "failed",
                        "error_message": result.get("error", "Unknown error"),
                        "completed_at": datetime.utcnow().isoformat()
                    }) \
                    .eq("id", scenario_id) \
                    .execute()
                
                print(f"   ❌ Failed: {result.get('error', 'Unknown error')[:100]}")
                
        except KeyboardInterrupt:
            print(f"\n\n🛑 Stopped by user. Total solved: {solved_count}")
            break
        except Exception as e:
            print(f"❌ Error: {str(e)}")
            time.sleep(10)

# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    process_queue()
