#!/usr/bin/env python3
"""
Script to analyze the VectorMagic SVG file and identify where number paths are located.
This will help us understand the coordinate ranges for the three stat numbers:
- Total Members (left): "72,850"
- Club Level (center): "50"
- Active Players (right): "18,211"
"""

import re
import xml.etree.ElementTree as ET
from collections import defaultdict

SVG_PATH = "/Users/smarter.poker/Downloads/CLUB TEMPLATE 1.svg"

def parse_path_bounds(d_attribute):
    """Extract bounding coordinates from a path's d attribute."""
    # Extract all numeric coordinates from the path
    numbers = re.findall(r'[-+]?\d*\.?\d+', d_attribute)
    if len(numbers) < 2:
        return None
    
    coords = [float(n) for n in numbers]
    # Paths have alternating x,y coordinates typically
    x_coords = []
    y_coords = []
    
    # Parse the path data more carefully
    commands = re.findall(r'([MLHVCSQTAZ])([^MLHVCSQTAZ]*)', d_attribute, re.IGNORECASE)
    
    current_x, current_y = 0, 0
    
    for cmd, params in commands:
        params = params.strip()
        nums = [float(n) for n in re.findall(r'[-+]?\d*\.?\d+', params)]
        
        if cmd in 'Mm':
            # Move to
            if len(nums) >= 2:
                if cmd == 'M':
                    current_x, current_y = nums[0], nums[1]
                else:
                    current_x += nums[0]
                    current_y += nums[1]
                x_coords.append(current_x)
                y_coords.append(current_y)
        elif cmd in 'Ll':
            # Line to
            for i in range(0, len(nums)-1, 2):
                if cmd == 'L':
                    current_x, current_y = nums[i], nums[i+1]
                else:
                    current_x += nums[i]
                    current_y += nums[i+1]
                x_coords.append(current_x)
                y_coords.append(current_y)
        elif cmd in 'Hh':
            # Horizontal line
            for n in nums:
                if cmd == 'H':
                    current_x = n
                else:
                    current_x += n
                x_coords.append(current_x)
        elif cmd in 'Vv':
            # Vertical line
            for n in nums:
                if cmd == 'V':
                    current_y = n
                else:
                    current_y += n
                y_coords.append(current_y)
        elif cmd in 'Cc':
            # Cubic bezier
            for i in range(0, len(nums)-5, 6):
                if cmd == 'C':
                    x_coords.extend([nums[i], nums[i+2], nums[i+4]])
                    y_coords.extend([nums[i+1], nums[i+3], nums[i+5]])
                    current_x, current_y = nums[i+4], nums[i+5]
        elif cmd == 'Z' or cmd == 'z':
            pass  # Close path
    
    if not x_coords or not y_coords:
        return None
    
    return {
        'min_x': min(x_coords),
        'max_x': max(x_coords),
        'min_y': min(y_coords),
        'max_y': max(y_coords)
    }

def analyze_svg():
    """Analyze the SVG to find paths that might be numbers."""
    with open(SVG_PATH, 'r') as f:
        content = f.read()
    
    # Parse SVG
    root = ET.fromstring(content)
    
    # Get viewBox
    viewbox = root.get('viewBox')
    print(f"ViewBox: {viewbox}")
    
    # Find all paths
    paths = root.findall('.//{http://www.w3.org/2000/svg}path')
    if not paths:
        paths = root.findall('.//path')
    
    print(f"Total paths: {len(paths)}")
    
    # Analyze path bounds
    path_data = []
    for i, path in enumerate(paths):
        d = path.get('d', '')
        fill = path.get('fill', '')
        bounds = parse_path_bounds(d)
        if bounds:
            path_data.append({
                'index': i,
                'fill': fill,
                'bounds': bounds,
                'd': d[:100]  # First 100 chars for debugging
            })
    
    # Group paths by Y coordinate range (to find rows)
    y_ranges = defaultdict(list)
    for p in path_data:
        y_mid = (p['bounds']['min_y'] + p['bounds']['max_y']) / 2
        # Round to nearest 50 to group
        y_bucket = round(y_mid / 50) * 50
        y_ranges[y_bucket].append(p)
    
    print("\n=== Path distribution by Y coordinate ===")
    for y, paths_in_range in sorted(y_ranges.items()):
        print(f"Y ~{y}: {len(paths_in_range)} paths")
    
    # Look for paths in the bottom portion (where stats typically are)
    # Stats are usually in the lower 20% of the image
    if viewbox:
        vb_parts = viewbox.split()
        total_height = float(vb_parts[3])
        bottom_y = total_height * 0.8  # Bottom 20%
        
        print(f"\n=== Paths in bottom 20% (Y > {bottom_y}) ===")
        bottom_paths = [p for p in path_data if p['bounds']['min_y'] > bottom_y]
        
        # Group by X coordinate for left/center/right
        x_groups = defaultdict(list)
        for p in bottom_paths:
            x_mid = (p['bounds']['min_x'] + p['bounds']['max_x']) / 2
            vb_width = float(vb_parts[2])
            
            # Divide into thirds
            if x_mid < vb_width / 3:
                region = 'left (Total Members)'
            elif x_mid < 2 * vb_width / 3:
                region = 'center (Club Level)'
            else:
                region = 'right (Active Players)'
            
            x_groups[region].append(p)
        
        for region, paths_in_region in sorted(x_groups.items()):
            print(f"\n{region}:")
            print(f"  Paths: {len(paths_in_region)}")
            if paths_in_region:
                all_min_x = min(p['bounds']['min_x'] for p in paths_in_region)
                all_max_x = max(p['bounds']['max_x'] for p in paths_in_region)
                all_min_y = min(p['bounds']['min_y'] for p in paths_in_region)
                all_max_y = max(p['bounds']['max_y'] for p in paths_in_region)
                print(f"  Bounding box: X: {all_min_x:.1f} - {all_max_x:.1f}, Y: {all_min_y:.1f} - {all_max_y:.1f}")
                
                # Sample fills
                fills = set(p['fill'] for p in paths_in_region[:10])
                print(f"  Sample fills: {fills}")

if __name__ == '__main__':
    analyze_svg()
