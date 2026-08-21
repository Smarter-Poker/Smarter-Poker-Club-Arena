import re

path_tsx = 'src/components/table/SeatSlot.tsx'
with open(path_tsx, 'r') as f:
    text = f.read()

text = text.replace("replace(\'\\.webp$\', \'@2x.webp\')", "replace(/\\.webp$/, '@2x.webp')")

with open(path_tsx, 'w') as f:
    f.write(text)

