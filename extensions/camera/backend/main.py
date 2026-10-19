"""Camera extension backend.

Owns the shared OpenCV install. Dependents import cv2 from this
environment's site-packages; they do not list opencv in their own
requirements.txt.
"""

from flask import Blueprint, jsonify

blueprint = Blueprint('camera', __name__)


@blueprint.route('/status')
def status():
    try:
        import cv2
        version = getattr(cv2, '__version__', '')
    except Exception as exc:
        return jsonify({
            'success': False,
            'error': 'OpenCV is not installed in the camera environment: ' + str(exc),
        })
    return jsonify({'success': True, 'opencv': version})
