"""Manifest v1 stays loadable. v2 rejects unsafe manifests. First directory wins."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.extension_registry import discover
from server.manifest_schema import validate_manifest


CAMERA_V1 = {
    'name': 'camera',
    'displayName': 'Camera',
    'version': '1.0.0',
    'permissions': ['camera'],
    'contributes': {
        'backend': {'main': 'backend/main.py'},
        'blocks': {'files': ['blocks/blocks.json']},
    },
}


class ManifestSchemaTests(unittest.TestCase):
    def test_legacy_camera_manifest_loads(self):
        result = validate_manifest(CAMERA_V1, directory_name='camera', root='')
        self.assertTrue(result['ok'], result['errors'])
        self.assertEqual(result['normalized']['manifestVersion'], 1)
        self.assertEqual(result['normalized']['extensionApiVersion'], 1)

    def test_future_api_is_rejected(self):
        manifest = dict(CAMERA_V1)
        manifest['manifestVersion'] = 2
        manifest['extensionApiVersion'] = 99
        result = validate_manifest(manifest, directory_name='camera')
        self.assertFalse(result['ok'])
        self.assertTrue(any('API version' in error for error in result['errors']))

    def test_unknown_permission_is_rejected(self):
        manifest = dict(CAMERA_V1)
        manifest['permissions'] = ['camera', 'not-a-permission']
        result = validate_manifest(manifest, directory_name='camera')
        self.assertFalse(result['ok'])

    def test_path_escape_and_precedence_and_blocks_only(self):
        with tempfile.TemporaryDirectory() as root:
            user = os.path.join(root, 'user')
            project = os.path.join(root, 'project')
            os.makedirs(os.path.join(user, 'camera', 'blocks'))
            os.makedirs(os.path.join(project, 'camera'))
            os.makedirs(os.path.join(project, 'badext'))
            os.makedirs(os.path.join(project, 'sensor'))
            with open(os.path.join(user, 'camera', 'extension.json'), 'w', encoding='utf-8') as handle:
                json.dump(CAMERA_V1, handle)
            with open(os.path.join(user, 'camera', 'blocks', 'blocks.json'), 'w', encoding='utf-8') as handle:
                json.dump([{'type': 'camera_setup'}], handle)
            with open(os.path.join(project, 'camera', 'extension.json'), 'w', encoding='utf-8') as handle:
                later = dict(CAMERA_V1)
                later['version'] = '9.9.9'
                json.dump(later, handle)
            with open(os.path.join(project, 'badext', 'extension.json'), 'w', encoding='utf-8') as handle:
                json.dump({
                    'name': 'badext',
                    'version': '1.0.0',
                    'contributes': {'backend': {'main': '../secret.py'}},
                }, handle)
            with open(os.path.join(project, 'sensor', 'extension.json'), 'w', encoding='utf-8') as handle:
                json.dump({
                    'name': 'sensor',
                    'version': '1.0.0',
                    'contributes': {'blocks': {'files': ['blocks/blocks.json']}},
                }, handle)
            found = discover([user, project])
        ids = [item['id'] for item in found['accepted']]
        self.assertEqual(ids.count('camera'), 1)
        self.assertEqual(found['accepted'][0]['manifest']['version'], '1.0.0')
        self.assertIn('camera_setup', found['accepted'][0]['block_types'])
        self.assertIn('sensor', ids)
        self.assertFalse(next(item for item in found['accepted'] if item['id'] == 'sensor')['has_backend'])
        self.assertTrue(any(item['id'] == 'badext' for item in found['rejected']))


if __name__ == '__main__':
    unittest.main()
