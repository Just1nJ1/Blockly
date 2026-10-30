"""Blockly environment requirements are checked before pip runs."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import environments


class BlocklyRequirementTests(unittest.TestCase):
    def test_satisfied_packages_are_not_installed_again(self):
        listed = {
            'success': True,
            'packages': [
                {'name': 'opencv-python', 'version': '4.10.0'},
                {'name': 'numpy', 'version': '1.26.4'},
            ],
        }
        with mock.patch.object(environments, 'list_packages', return_value=listed), \
                mock.patch.object(environments, '_install_requirements_direct') as install:
            checked = environments.requirements_not_satisfied(
                'blockly', 'opencv-python>=4.8\nnumpy>=1.26\n')
            result = environments.install_requirements(
                'blockly', 'opencv-python>=4.8\nnumpy>=1.26\n', only_missing=True)
        self.assertEqual(checked['missing'], [])
        self.assertEqual(len(checked['satisfied']), 2)
        install.assert_not_called()
        self.assertTrue(result['success'])
        self.assertEqual(result['installed'], [])

    def test_old_version_is_installed_and_a_match_is_kept(self):
        listed = {
            'success': True,
            'packages': [{'name': 'opencv-python', 'version': '4.5.0'}],
        }
        with mock.patch.object(environments, 'list_packages', return_value=listed), \
                mock.patch.object(
                    environments, '_install_requirements_direct',
                    return_value={'success': True, 'output': 'ok', 'log': []},
                ) as install:
            result = environments.install_requirements(
                'blockly', 'opencv-python>=4.8\n# comment\n', only_missing=True)
        install.assert_called_once_with('blockly', 'opencv-python>=4.8')
        self.assertEqual(result['installed'], ['opencv-python>=4.8'])
        self.assertTrue(result['success'])

    def test_pip_failure_is_returned_without_removing_packages(self):
        listed = {'success': True, 'packages': []}
        with mock.patch.object(environments, 'list_packages', return_value=listed), \
                mock.patch.object(
                    environments, '_install_requirements_direct',
                    return_value={'success': False, 'error': 'resolution conflict', 'log': []},
                ):
            result = environments.install_requirements(
                'blockly', 'opencv-python>=4.8', only_missing=True)
        self.assertFalse(result['success'])
        self.assertIn('resolution conflict', result['error'])

    def test_missing_environment_is_not_the_application_python(self):
        with mock.patch.object(
                environments, 'list_packages',
                return_value={'success': False, 'error': 'Environment not found or invalid'}):
            result = environments.requirements_not_satisfied('blockly', 'numpy>=1.26')
        self.assertFalse(result['success'])
        self.assertIn('not found', result['error'])


if __name__ == '__main__':
    unittest.main()
