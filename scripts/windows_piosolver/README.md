# PioSolver Batch Processing for Windows

This folder contains the scripts to run PioSolver batch solving on a Windows PC.
The solutions are automatically uploaded to Supabase for use in the PokerIQ training system.

## Quick Start

### 1. Copy to Windows PC
Copy this entire `windows_piosolver` folder to your Windows PC.

### 2. Install Python
Download and install Python 3.10+ from https://python.org
Make sure to check "Add Python to PATH" during installation.

### 3. Run Setup
Double-click `setup.bat` or run in Command Prompt:
```batch
setup.bat
```

### 4. Configure Environment
Edit `.env` file with your credentials:
```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
PIOSOLVER_PATH=C:\Program Files\PioSOLVER\PioSOLVER3-pro.exe
```

### 5. Start Batch Processing
```batch
python piosolver_batch_runner.py
```

The script will:
- Connect to Supabase and pull pending scenarios from the queue
- Generate PioSolver tree files
- Run PioSolver to solve each scenario  
- Upload results back to Supabase
- Repeat until stopped (Ctrl+C)

## Files

| File | Description |
|------|-------------|
| `setup.bat` | One-time setup script |
| `requirements.txt` | Python dependencies |
| `.env.example` | Configuration template |
| `piosolver_batch_runner.py` | Main batch processing script |

## Supabase Credentials

Get your credentials from the Supabase dashboard:
1. Go to Project Settings → API
2. Copy the **Project URL** → `SUPABASE_URL`
3. Copy the **service_role key** → `SUPABASE_SERVICE_KEY`

⚠️ **IMPORTANT**: Use the `service_role` key (not `anon` key) for write access.

## Adding Scenarios to Queue

Scenarios are added to the queue by the seed script on the Mac:
```bash
python scripts/seed_gto_scenarios.py
```

This populates `gto_solve_queue` with scenarios to solve.
