"""
Sample extension backend.

Provides a single endpoint that jogs ALL connected robotic arms
along the X axis by a given step (positive = forward, negative = backward).
"""

from flask import Blueprint, request, jsonify

blueprint = Blueprint("sample", __name__)


@blueprint.route("/jog-all-x", methods=["POST"])
def jog_all_x():
    """Jog every connected arm by `step` mm along the X axis (incremental)."""
    from server.serial_manager import SerialManager

    data = request.get_json() or {}
    step = float(data.get("step", 5))

    mgr = SerialManager.get_instance()
    connections = mgr.all_connected()

    if not connections:
        return jsonify({"success": False, "error": "No robots connected"})

    results = []
    for conn in connections:
        try:
            if not conn.robot:
                results.append({"port": conn.port, "success": False, "error": "No SDK"})
                continue
            # writeCoordinate(motion, mode, **axes)
            #   motion=0  -> MOVJ (fast)
            #   mode=1    -> incremental
            conn.robot.writeCoordinate(0, 1, x=step)
            results.append({"port": conn.port, "success": True})
        except Exception as e:
            results.append({"port": conn.port, "success": False, "error": str(e)})

    return jsonify({"success": True, "results": results})