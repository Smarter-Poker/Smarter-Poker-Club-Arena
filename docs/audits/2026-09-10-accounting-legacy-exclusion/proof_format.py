"""Normalize generated evidence with the repository's pinned formatter before hashing."""
import subprocess
from pathlib import Path
def format_proof(path):
 root=Path(__file__).resolve().parents[3]
 subprocess.run([str(root/'node_modules/.bin/prettier'),'--write',str(path)],check=True,stdout=subprocess.DEVNULL)
