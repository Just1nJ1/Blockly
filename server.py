#!/usr/bin/env python3
"""
Python backend server for WLKATA StudioX.
Provides a REST API to execute Python code sent from the Electron frontend.
Uses Flask for better request handling.
"""

import argparse
import logging
from server.app import create_app


def run_server(host='127.0.0.1', port=5080, debug=False, extensions_dirs=None):
    """Start the Flask server."""
    # Suppress werkzeug request logs (GET/POST spam)
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    app = create_app(extensions_dirs=extensions_dirs)
    print(f"Starting StudioX Server at http://{host}:{port}")
    print("Press Ctrl+C to stop")
    app.run(host=host, port=port, debug=debug, threaded=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='WLKATA StudioX Server')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=5080, help='Port to bind to (default: 5080)')
    parser.add_argument('--debug', action='store_true', help='Enable debug mode')
    parser.add_argument('--extensions-dir', action='append', default=None, help='Path to extensions directory (can be specified multiple times)')
    args = parser.parse_args()

    run_server(host=args.host, port=args.port, debug=args.debug, extensions_dirs=args.extensions_dir)
