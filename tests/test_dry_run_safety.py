"""World and G-code dry-runs keep robot behavior and do not open hardware.

The strings below are the shapes produced by the StudioX simulation target
and by portable Camera generation. Changing the portable text must not be
what these endpoints execute.
"""

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.gcode_export import GcodeExporter
from server.move_simulator import MoveSimulator


def _arm(name):
    return (
        "import wlkatapython\n"
        "import serial\n"
        "%s = wlkatapython.Mirobot_UART()\n"
        "%s.init(serial.Serial('COM1', 115200), -1)\n" % (name, name)
    )


class DryRunSafetyTests(unittest.TestCase):
    def test_robot_only_records_motion_order(self):
        code = (
            _arm('arm')
            + "arm.homing()\n"
            + "arm.writeCoordinate(0, 0, 1, 2, 3, 0, 0, 0)\n"
            + "arm.writeAngle(0, 10, 0, 0, 0, 0, 0)\n"
            + "arm.waitIdle()\n"
        )
        first = MoveSimulator.simulate(code)
        second = MoveSimulator.simulate(code)
        self.assertTrue(first['success'], first.get('error'))
        self.assertEqual([move['type'] for move in first['moves']['arm']], [
            'homing', 'writeCoordinate', 'writeAngle',
        ])
        self.assertEqual(first['moves'], second['moves'])
        self.assertEqual(first['schedule'], second['schedule'])
        self.assertEqual(first['device_opens'], [])
        self.assertTrue(any(item['move']['type'] == 'writeAngle' for item in first['schedule']))
        self.assertGreaterEqual(first['schedule'][-1]['start'], 2)

    def test_two_robots_loops_and_conditionals(self):
        code = (
            "import wlkatapython\n"
            "import serial\n"
            "left = wlkatapython.Mirobot_UART()\n"
            "right = wlkatapython.Mirobot_UART()\n"
            "left.init(serial.Serial('COM1', 115200), -1)\n"
            "right.init(serial.Serial('COM2', 115200), -1)\n"
            "for i in range(3):\n"
            "    if i != 1:\n"
            "        left.writeAngle(0, i, 0, 0, 0, 0, 0)\n"
            "right.writeCoordinate(0, 0, 5, 0, 0, 0, 0, 0)\n"
            "left.waitIdle()\n"
            "right.writeAngle(0, 1, 0, 0, 0, 0, 0)\n"
        )
        result = MoveSimulator.simulate(code)
        self.assertTrue(result['success'], result.get('error'))
        self.assertEqual(len(result['moves']['left']), 2)
        self.assertEqual(
            [move['Axis1'] for move in result['moves']['left']],
            [0.0, 2.0],
        )
        self.assertEqual(
            [move['type'] for move in result['moves']['right']],
            ['writeCoordinate', 'writeAngle'],
        )
        self.assertEqual(result['device_opens'], [])
        left_slots = [item for item in result['schedule'] if item['var'] == 'left']
        self.assertEqual(left_slots[0]['start'], 0)
        self.assertEqual(left_slots[1]['start'], 1)

    def test_mixed_camera_placeholder_does_not_open_a_device(self):
        code = (
            _arm('arm')
            + "cap = __studiox_simulation_placeholder('camera', 'open_camera', 0)\n"
            + "frame = cap.read()[1]\n"
            + "frame = __studiox_simulation_note("
            + "'Camera resize is not applied during simulation', frame)\n"
            + "if frame:\n"
            + "    arm.writeAngle(0, 4, 0, 0, 0, 0, 0)\n"
            + "arm.waitIdle()\n"
        )
        result = MoveSimulator.simulate(code)
        self.assertTrue(result['success'], result.get('error'))
        self.assertEqual(len(result['moves']['arm']), 1)
        self.assertEqual(result['moves']['arm'][0]['Axis1'], 4.0)
        self.assertEqual(result['device_opens'], [])
        self.assertTrue(any('open_camera' in warning for warning in result['warnings']))
        self.assertTrue(any('resize' in warning for warning in result['warnings']))

    def test_portable_video_capture_is_refused_if_it_reaches_a_dry_run(self):
        opened = []
        fake = types.ModuleType('cv2')

        def boom(*args, **kwargs):
            opened.append(args)
            raise AssertionError('real camera opened')

        fake.VideoCapture = boom
        previous = sys.modules.get('cv2')
        sys.modules['cv2'] = fake
        try:
            result = MoveSimulator.simulate('import cv2\ncv2.VideoCapture(0)\n')
        finally:
            if previous is None:
                sys.modules.pop('cv2', None)
            else:
                sys.modules['cv2'] = previous
        self.assertEqual(opened, [])
        self.assertEqual(result['device_opens'], ['cv2.VideoCapture'])
        self.assertIn('would open a device', result.get('error') or '')

    def test_unsupported_hardware_block_stops_without_dropping_earlier_moves(self):
        code = (
            _arm('arm')
            + "arm.writeAngle(0, 1, 0, 0, 0, 0, 0)\n"
            + "__studiox_simulation_unsupported('pump is not available during simulation')\n"
            + "arm.writeAngle(0, 9, 0, 0, 0, 0, 0)\n"
        )
        result = MoveSimulator.simulate(code)
        self.assertEqual(len(result['moves']['arm']), 1)
        self.assertEqual(result['moves']['arm'][0]['Axis1'], 1.0)
        self.assertIn('pump is not available', result.get('error') or '')
        self.assertEqual(result['device_opens'], [])

    def test_cleanup_runs_on_failure_and_does_not_skip_later_resources(self):
        released = []

        class Resource:
            def __init__(self, name, fail=False):
                self.name = name
                self.fail = fail

            def release(self):
                released.append(self.name)
                if self.fail:
                    raise RuntimeError(self.name)

        namespace = {'Resource': Resource, 'released': released}
        code = (
            "cap = Resource('cap')\n"
            "cap2 = Resource('cap2', fail=True)\n"
            "try:\n"
            "    raise RuntimeError('program failed')\n"
            "finally:\n"
            "    try:\n"
            "        cap2.release()\n"
            "    except Exception:\n"
            "        pass\n"
            "    try:\n"
            "        cap.release()\n"
            "    except Exception:\n"
            "        pass\n"
        )
        with self.assertRaises(RuntimeError):
            exec(code, namespace)
        self.assertEqual(released, ['cap2', 'cap'])

        interrupted = []
        namespace = {'interrupted': interrupted}
        code = (
            "try:\n"
            "    raise KeyboardInterrupt\n"
            "finally:\n"
            "    try:\n"
            "        interrupted.append('released')\n"
            "    except Exception:\n"
            "        pass\n"
        )
        with self.assertRaises(KeyboardInterrupt):
            exec(code, namespace)
        self.assertEqual(interrupted, ['released'])

    def test_gcode_export_keeps_delay_lines_and_opens_nothing(self):
        code = (
            "import wlkatapython\n"
            "import serial\n"
            "import time\n"
            "arm = wlkatapython.Mirobot_UART()\n"
            "arm.init(serial.Serial('COM1', 115200), -1)\n"
            "arm.writeAngle(0, 10, 0, 0, 0, 0, 0)\n"
            "time.sleep(1)\n"
            "cap = __studiox_simulation_placeholder('camera', 'open_camera', 0)\n"
            "arm.waitIdle()\n"
        )
        first = GcodeExporter.export(code)
        second = GcodeExporter.export(code)
        self.assertTrue(first['success'], first.get('error'))
        self.assertEqual(first['lines'], second['lines'])
        self.assertIn('G4 P1', first['lines'])
        self.assertEqual(first['device_opens'], [])
        self.assertTrue(any('open_camera' in warning for warning in first['warnings']))


if __name__ == '__main__':
    unittest.main()
