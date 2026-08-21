import re

with open('src/components/table/LeaderboardPanel.css', 'r') as f:
    content = f.read()

# Change hex colors
content = content.replace('#FFB800', '#00D4FF')
content = content.replace('#ffb800', '#00D4FF')

# Change rgb/rgba colors
content = content.replace('rgba(255, 184, 0,', 'rgba(0, 212, 255,')
content = content.replace('rgb(255, 184, 0)', 'rgb(0, 212, 255)')

# Increase padding-top for podium to prevent clipping
content = content.replace('padding: 24px 20px 16px;', 'padding: 40px 20px 16px;')

with open('src/components/table/LeaderboardPanel.css', 'w') as f:
    f.write(content)
