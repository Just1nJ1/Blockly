"""
Loads the robot model definitions from robots.json.
Single source of truth for model names, firmware prefixes, and Blockly values.
"""

import json
import os

_json_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'robots.json')

with open(_json_path, 'r') as f:
    ROBOTS = json.load(f)

# Lookup: firmware prefix → model name  (used by detector)
# fwPrefix can be a string or a list of strings
FW_PREFIX_MAP = {}
for _r in ROBOTS:
    _prefixes = _r['fwPrefix']
    if isinstance(_prefixes, str):
        _prefixes = [_prefixes]
    for _p in _prefixes:
        FW_PREFIX_MAP[_p] = _r['name']