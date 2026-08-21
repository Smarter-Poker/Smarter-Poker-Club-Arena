import re

path_tsx = 'src/components/table/SeatSlot.tsx'
with open(path_tsx, 'r') as f:
    text = f.read()

if 'srcSet=' not in text:
    text = re.sub(
        r'src=\{avatarUrl\}',
        r'src={avatarUrl}\n                srcSet={`${avatarUrl} 1x, ${avatarUrl.replace(\'\\.webp$\', \'@2x.webp\')} 2x`}',
        text
    )
    with open(path_tsx, 'w') as f:
        f.write(text)

path_css = 'src/components/table/SeatSlot.css'
with open(path_css, 'r') as f:
    text = f.read()

text = re.sub(
    r'\.seat__avatar--bust \.seat__avatar-img\[src\*\=\'/avatars/table/\'\]\s*\{[^}]+\}',
    '',
    text
)
with open(path_css, 'w') as f:
    f.write(text)
