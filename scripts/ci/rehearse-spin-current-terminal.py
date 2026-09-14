#!/usr/bin/env python3
"""Compatibility entrypoint for the only supported current terminal rehearsal."""

import os
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
probe = repo / "scripts/dev/probe-stage-b-forward-chain-pg17.sh"
os.execv(str(probe), [str(probe), *sys.argv[1:]])
