#!/usr/bin/env python3
"""Local compatibility entry; the installed reader has one canonical source."""
from pathlib import Path
import runpy
globals().update(runpy.run_path(str(Path(__file__).resolve().parents[2] / "operations/release/native/read-native-frontend.py"), run_name=__name__))
