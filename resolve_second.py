import re

with open('src/pages/TablePage.tsx', 'r') as f:
    content = f.read()

parts = content.split('<<<<<<< HEAD\n')
if len(parts) > 1:
    out = parts[0]
    for i in range(1, len(parts)):
        block, rest = parts[i].split('>>>>>>>', 1)
        rest = rest.split('\n', 1)[1] if '\n' in rest else rest
        ours, theirs = block.split('=======\n', 1)
        out += ours  # Always keep HEAD for this since it's just formatBlindPair vs template string
        out += rest
        
    with open('src/pages/TablePage.tsx', 'w') as f:
        f.write(out)
