#!/usr/bin/env python3
"""
Modify the VectorMagic SVG to replace vectorized number paths with dynamic <text> elements.

This script will:
1. Parse the SVG file
2. Identify and remove paths that represent the stat numbers (in specific coordinate regions)
3. Add new <text> elements with IDs for dynamic binding:
   - id="total-members" (left)
   - id="club-level" (center)
   - id="active-players" (right)
4. Save the modified SVG
"""

import re
import os

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
                # Process additional implicit line-to commands
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
                else:
                    x_coords.extend([current_x + nums[i], current_x + nums[i+2], current_x + nums[i+4]])
                    y_coords.extend([current_y + nums[i+1], current_y + nums[i+3], current_y + nums[i+5]])
                    current_x += nums[i+4]
                    current_y += nums[i+5]
        elif cmd in 'Ss':
            for i in range(0, len(nums)-3, 4):
                if cmd == 'S':
                    x_coords.extend([nums[i], nums[i+2]])
                    y_coords.extend([nums[i+1], nums[i+3]])
                    current_x, current_y = nums[i+2], nums[i+3]
        elif cmd in 'Qq':
            for i in range(0, len(nums)-3, 4):
                if cmd == 'Q':
                    x_coords.extend([nums[i], nums[i+2]])
                    y_coords.extend([nums[i+1], nums[i+3]])
                    current_x, current_y = nums[i+2], nums[i+3]
                    
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
    """
    Determine if a path is likely part of the number text.
    Numbers are typically:
    - In specific Y ranges (around Y 870-920 for the main numbers based on the SVG analysis)
    - Have specific color fills (lighter colors for the text itself)
    - Are in the three column regions
    """
    if not bounds:
        return False, None
    
    # The numbers appear to be in the lower portion of the stats panel
    # Based on viewBox 0 0 597 1024, the stats panel occupies roughly Y 800-1024
    # The actual numbers are likely in Y ~870-930 range (labels above, padding around)
    
    min_y = bounds['min_y']
    max_y = bounds['max_y']
    center_x = bounds['center_x']
    center_y = bounds['center_y']
    
    # Number text is likely in Y range 860-940 (approximate, needs visual verification)
    # These are the actual digit glyphs, not the labels or decorative elements
    if not (860 < center_y < 940):
        return False, None
    
    # Light fills typical of text (white, light gray, light cyan, etc.)
    # Looking at fills from the analysis - number colors should be lighter/brighter
    light_fills = [
        '#ffffff', '#fefefe', '#fdfdfd', '#fcfcfc', '#fbfbfb', '#fafafa',
        '#f9f9f9', '#f8f8f8', '#f7f7f7', '#f6f6f6', '#f5f5f5', '#f4f4f4',
        '#e0e0e0', '#d0d0d0', '#c0c0c0', '#b0b0b0', '#a0a0a0',
        '#00d4ff', '#00c8f0', '#00bce0', '#00b0d0', '#00a4c0',  # Cyan tones
    ]
    
    # Check if it's a light-colored fill (text is usually light on dark background)
    fill_lower = fill.lower() if fill else ''
    
    # Parse RGB from hex to check brightness
    if fill_lower.startswith('#') and len(fill_lower) == 7:
        try:
            r = int(fill_lower[1:3], 16)
            g = int(fill_lower[3:5], 16)
            b = int(fill_lower[5:7], 16)
            brightness = (r + g + b) / 3
            
            # Text is typically brighter (>150 on 0-255 scale for a dark-theme card)
            if brightness > 140:
                # Determine which region (left/center/right)
                if center_x < 199:  # Left third (0-199)
                    return True, 'left'
                elif center_x < 398:  # Center third (199-398)
                    return True, 'center'
                else:  # Right third (398-597)
                    return True, 'right'
        except:
            pass
    
    return False, None


def modify_svg():
    """Main function to modify the SVG file."""
    print(f"Reading SVG from: {INPUT_SVG}")
    
    with open(INPUT_SVG, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find all path elements using regex
    path_pattern = r'<path\s+d="([^"]+)"\s+fill="([^"]+)"\s*/>'
    
    paths_to_remove = {'left': [], 'center': [], 'right': []}
    all_matches = list(re.finditer(path_pattern, content))
    
    print(f"Found {len(all_matches)} path elements")
    
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
    
    print(f"\nPaths identified as number text:")
    print(f"  Left (Total Members): {len(paths_to_remove['left'])} paths")
    print(f"  Center (Club Level): {len(paths_to_remove['center'])} paths")
    print(f"  Right (Active Players): {len(paths_to_remove['right'])} paths")
    
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
            print(f"  {region} center: ({text_positions[region]['x']:.1f}, {text_positions[region]['y']:.1f})")
    
    # Remove the number paths from SVG content
    modified_content = content
    for region in paths_to_remove:
        for path in paths_to_remove[region]:
            modified_content = modified_content.replace(path, '')
    
    # Calculate approximate positions for the text elements based on SVG structure
    # Using viewBox 0 0 597 1024 - the three stats occupy roughly equal horizontal space
    # Left stat: ~100 X center
    # Center stat: ~298.5 X center  
    # Right stat: ~497 X center
    # Y position: approximately 900 (middle of the stats area)
    
    if not text_positions.get('left'):
        text_positions['left'] = {'x': 100, 'y': 900}
    if not text_positions.get('center'):
        text_positions['center'] = {'x': 298.5, 'y': 900}
    if not text_positions.get('right'):
        text_positions['right'] = {'x': 497, 'y': 900}
    
    # Create new text elements
    text_elements = f'''
    <!-- Dynamic stat text elements -->
    <style>
        .stat-number {{
            font-family: 'Arial Black', 'Helvetica Neue', sans-serif;
            font-weight: bold;
            fill: #ffffff;
            text-anchor: middle;
            dominant-baseline: middle;
        }}
    </style>
    <text id="total-members" class="stat-number" x="{text_positions['left']['x']}" y="{text_positions['left']['y']}" font-size="48">72,850</text>
    <text id="club-level" class="stat-number" x="{text_positions['center']['x']}" y="{text_positions['center']['y']}" font-size="48">50</text>
    <text id="active-players" class="stat-number" x="{text_positions['right']['x']}" y="{text_positions['right']['y']}" font-size="48">18,211</text>
'''
    
    # Insert text elements before closing </svg> tag
    modified_content = modified_content.replace('</svg>', text_elements + '\n</svg>')
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(OUTPUT_SVG), exist_ok=True)
    
    # Write modified SVG
    with open(OUTPUT_SVG, 'w', encoding='utf-8') as f:
        f.write(modified_content)
    
    print(f"\nModified SVG saved to: {OUTPUT_SVG}")
    print(f"Removed {sum(len(v) for v in paths_to_remove.values())} number paths")
    print("Added 3 <text> elements with IDs: total-members, club-level, active-players")


if __name__ == '__main__':
    modify_svg()
