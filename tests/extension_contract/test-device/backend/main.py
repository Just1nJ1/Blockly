"""Mock device list. This process is not started by the runtime tests."""

from flask import Blueprint, jsonify

blueprint = Blueprint('test_device', __name__)


@blueprint.route('/ports')
def ports():
    return jsonify({
        'ports': [
            {'id': 'A', 'name': 'Port A'},
            {'id': 'B', 'name': 'Port B'},
        ],
    })


@blueprint.route('/health')
def health():
    return jsonify({'ok': True})
