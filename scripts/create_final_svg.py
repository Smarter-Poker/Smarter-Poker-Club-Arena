#!/usr/bin/env python3
"""
Create a final clean SVG from the ORIGINAL source with proper dynamic text elements.
This script removes number paths AND any previous text/style attempts, then adds clean ones.
"""

import re

INPUT_SVG = "/Users/smarter.poker/Downloads/CLUB TEMPLATE 1.svg"
OUTPUT_SVG = "/Users/smarter.poker/Documents/club-arena/public/club-stats-panel.svg"

def parse_path_bounds(d_attribute):
    """Extract bounding coordinates from a path's d attribute."""
    commands = re.findall(r'([MLHVCSQTAZ])([^MLHVCSQTAZ]*)', d_attribute, re.IGNORECASE)
    
    x_coords = []
    y_coords = []
    current_x, current_y = 0, 0
    
    for cmd, params in commands:
        params = params.strip()
        nums = [float(n) for n in re.findall(r'[-+]?\d*\.?\d+', params)]
        
        if cmd in 'Mm':
            if len(nums) >= 2:
                if cmd == 'M':
                    current_x, current_y = nums[0], nums[1]
                else:
                    current_x += nums[0]
                    current_y += nums[1]
                x_coords.append(current_x)
                y_coords.append(current_y)
                for i in range(2, len(nums)-1, 2):
                    if cmd == 'M':
                        current_x, current_y = nums[i], nums[i+1]
                    else:
                        current_x += nums[i]
                        current_y += nums[i+1]
                    x_coords.append(current_x)
                    y_coords.append(current_y)
        elif cmd in 'Ll':
            for i in range(0, len(nums)-1, 2):
                if cmd == 'L':
                    current_x, current_y = nums[i], nums[i+1]
                else:
                    current_x += nums[i]
                    current_y += nums[i+1]
                x_coords.append(current_x)
                y_coords.append(current_y)
        elif cmd in 'Hh':
            for n in nums:
                if cmd == 'H':
                    current_x = n
                else:
                    current_x += n
                x_coords.append(current_x)
        elif cmd in 'Vv':
            for n in nums:
                if cmd == 'V':
                    current_y = n
                else:
                    current_y += n
                y_coords.append(current_y)
        elif cmd in 'Cc':
            for i in range(0, len(nums)-5, 6):
                if cmd == 'C':
                    x_coords.extend([nums[i], nums[i+2], nums[i+4]])
                    y_coords.extend([nums[i+1], nums[i+3], nums[i+5]])
                    current_x, current_y = nums[i+4], nums[i+5]
                    
    if not x_coords or not y_coords:
        return None
    
    return {
        'min_x': min(x_coords),
        'max_x': max(x_coords),
        'min_y': min(y_coords),
        'max_y': max(y_coords),
        'center_x': (min(x_coords) + max(x_coords)) / 2,
        'center_y': (min(y_coords) + max(y_coords)) / 2
    }


def is_number_path(bounds, fill):
    """Determine if a path is likely part of the stat number text."""
    if not bounds:
        return False, None
    
    center_y = bounds['center_y']
    center_x = bounds['center_x']
    
    # Numbers are in Y range 860-940 (the main stat digits)
    if not (860 < center_y < 940):
        return False, None
    
    fill_lower = fill.lower() if fill else ''
    
    # Parse RGB from hex to check brightness
    if fill_lower.startswith('#') and len(fill_lower) == 7:
        try:
            r = int(fill_lower[1:3], 16)
            g = int(fill_lower[3:5], 16)
            b = int(fill_lower[5:7], 16)
            brightness = (r + g + b) / 3
            
            # Text is typically brighter (white/light colored)
            if brightness > 140:
                # viewBox is 0 0 597 1024, divide into thirds
                if center_x < 199:  # Left third
                    return True, 'left'
                elif center_x < 398:  # Center third
                    return True, 'center'
                else:  # Right third
                    return True, 'right'
        except:
            pass
    
    return False, None


def create_final_svg():
    """Create the final clean SVG with proper dynamic text elements."""
    print(f"Reading original SVG from: {INPUT_SVG}")
    
    with open(INPUT_SVG, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find all path elements
    path_pattern = r'<path\s+d="([^"]+)"\s+fill="([^"]+)"\s*/>'
    
    paths_to_remove = {'left': [], 'center': [], 'right': []}
    all_matches = list(re.finditer(path_pattern, content))
    
    print(f"Found {len(all_matches)} path elements in original SVG")
    
    # Analyze each path
    stats_bounds = {'left': [], 'center': [], 'right': []}
    
    for match in all_matches:
        d_attr = match.group(1)
        fill = match.group(2)
        
        bounds = parse_path_bounds(d_attr)
        is_num, region = is_number_path(bounds, fill)
        
        if is_num and region:
            paths_to_remove[region].append(match.group(0))
            stats_bounds[region].append(bounds)
    
    print(f"\nNumber text paths identified:")
    for region in ['left', 'center', 'right']:
        count = len(paths_to_remove[region])
        label = {'left': 'Total Members', 'center': 'Club Level', 'right': 'Active Players'}[region]
        print(f"  {label}: {count} paths")
    
    # Calculate center positions for text elements
    text_positions = {}
    for region in ['left', 'center', 'right']:
        if stats_bounds[region]:
            all_x = [b['center_x'] for b in stats_bounds[region]]
            all_y = [b['center_y'] for b in stats_bounds[region]]
            text_positions[region] = {
                'x': sum(all_x) / len(all_x),
                'y': sum(all_y) / len(all_y)
            }
    
    # Use calculated or default positions
    left_x = text_positions.get('left', {}).get('x', 100)
    left_y = text_positions.get('left', {}).get('y', 890)
    center_x = text_positions.get('center', {}).get('x', 298)
    center_y = text_positions.get('center', {}).get('y', 890)
    right_x = text_positions.get('right', {}).get('x', 497)
    right_y = text_positions.get('right', {}).get('y', 890)
    
    print(f"\nText element positions:")
    print(f"  total-members: ({left_x:.0f}, {left_y:.0f})")
    print(f"  club-level: ({center_x:.0f}, {center_y:.0f})")
    print(f"  active-players: ({right_x:.0f}, {right_y:.0f})")
    
    # Remove the number paths from content
    modified_content = content
    total_removed = 0
    for region in paths_to_remove:
        for path in paths_to_remove[region]:
            modified_content = modified_content.replace(path, '')
            total_removed += 1
    
    # Remove any previously added comments, styles, or text elements 
    # (from earlier attempts at editing this SVG)
    modified_content = re.sub(r'<!-- Dynamic.*?-->\s*', '', modified_content, flags=re.DOTALL)
    modified_content = re.sub(r'<!-- Position these.*?-->\s*', '', modified_content, flags=re.DOTALL)
    modified_content = re.sub(r'<!-- You may need.*?-->\s*', '', modified_content, flags=re.DOTALL)
    modified_content = re.sub(r'<style[^>]*>.*?</style>\s*', '', modified_content, flags=re.DOTALL)
    modified_content = re.sub(r'<text[^>]*>.*?</text>\s*', '', modified_content, flags=re.DOTALL)
    
    # The final text elements with proper IDs for dynamic binding
    text_elements = f'''
<!-- Dynamic Stats - IDs for JavaScript binding -->
<defs>
  <style type="text/css">
    .stat-value {{
      font-family: 'Inter', 'Segoe UI', 'Arial Black', sans-serif;
      font-weight: 700;
      fill: #ffffff;
      text-anchor: middle;
      dominant-baseline: middle;
    }}
  </style>
</defs>
<text id="total-members" class="stat-value" x="{left_x:.0f}" y="{left_y:.0f}" font-size="32">0</text>
<text id="club-level" class="stat-value" x="{center_x:.0f}" y="{center_y:.0f}" font-size="32">0</text>
<text id="active-players" class="stat-value" x="{right_x:.0f}" y="{right_y:.0f}" font-size="32">0</text>
'''
    
    # Insert before </svg>
    modified_content = modified_content.replace('</svg>', text_elements + '</svg>')
    
    # Write the final SVG
    with open(OUTPUT_SVG, 'w', encoding='utf-8') as f:
        f.write(modified_content)
    
    print(f"\n✅ Final SVG saved to: {OUTPUT_SVG}")
    print(f"   Removed {total_removed} number paths")
    print(f"   Added 3 <text> elements with IDs")


if __name__ == '__main__':
    create_final_svg()
