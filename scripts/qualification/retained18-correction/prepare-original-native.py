#!/usr/bin/env python3
"""Prepare maintained real hand-submission fixture inputs only; no acceptance verdict."""
import importlib.util, pathlib, sys
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/ci'))
spec=importlib.util.spec_from_file_location('original_hand_submission',ROOT/'scripts/ci/test-hand-submission.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
m.prepare(ROOT,out)
print('Prepared actual maintained foundation; no qualification verdict')
