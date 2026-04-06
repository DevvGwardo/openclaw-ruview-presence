#!/usr/bin/env python3
"""
RSSI Daemon for Hermes RuView Presence
Runs macos-wifi-scan every 2-3 seconds and serves results via HTTP.

Maintains rolling RSSI history (last 10 scans) and computes running variance.
HTTP endpoint mirrors RuView /api/v1/pose/current format.

Usage:
    python3 rssi_daemon.py [--port PORT] [--binary PATH]
"""

import json
import os
import signal
import subprocess
import sys
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Dict, List, Any, Optional

# Configuration
DEFAULT_BINARY_PATHS = [
    "/usr/local/bin/macos-wifi-scan",
    str(Path(__file__).parent.parent / "tools/macos-wifi-scan/macos-wifi-scan"),
]
DEFAULT_PORT = 3002
SCAN_INTERVAL = 2.5  # seconds (macOS CoreWLAN rate limit ~0.3-0.5 Hz)
RSSI_HISTORY_SIZE = 10
VARIANCE_THRESHOLD = 3.0  # dBm
NOISE_FLOOR = -85
BASELINE_CONFIDENCE = 0.5


class RSSIHistory:
    """Maintains rolling RSSI history and computes presence."""
    
    def __init__(self, max_size: int = RSSI_HISTORY_SIZE):
        self.max_size = max_size
        self.history: List[Dict[str, Any]] = []
        self.lock = threading.Lock()
    
    def add_scan(self, networks: Dict[str, float], timestamp: float) -> None:
        """Add a new scan to history."""
        with self.lock:
            self.history.append({
                "timestamp": timestamp,
                "networks": networks
            })
            while len(self.history) > self.max_size:
                self.history.pop(0)
    
    def _compute_variance(self, values: List[float]) -> float:
        """Compute standard deviation."""
        if len(values) < 2:
            return 0.0
        mean = sum(values) / len(values)
        variance = sum((x - mean) ** 2 for x in values) / len(values)
        return variance ** 0.5
    
    def compute_presence(self) -> Dict[str, Any]:
        """Compute presence from rolling history."""
        with self.lock:
            if not self.history:
                return {"detected": False, "confidence": 0.0}
            
            latest = self.history[-1]
            current_rssi = latest.get("networks", {})
            
            # Compute variance for each SSID
            ssid_variances: Dict[str, float] = {}
            for ssid in current_rssi:
                rssi_values = []
                for snapshot in self.history:
                    if ssid in snapshot.get("networks", {}):
                        rssi_values.append(snapshot["networks"][ssid])
                if len(rssi_values) >= 2:
                    ssid_variances[ssid] = self._compute_variance(rssi_values)
            
            # Detection: high variance = motion
            detected = False
            confidence = 0.0
            
            for ssid, var in ssid_variances.items():
                if var > VARIANCE_THRESHOLD:
                    detected = True
                    var_confidence = min(1.0, var / (VARIANCE_THRESHOLD * 2))
                    confidence = max(confidence, var_confidence)
            
            # Baseline: connected network above noise floor
            if not detected:
                # Assume first network is connected if any
                if current_rssi:
                    avg_rssi = sum(current_rssi.values()) / len(current_rssi)
                    if avg_rssi > NOISE_FLOOR:
                        detected = True
                        confidence = BASELINE_CONFIDENCE
            
            return {
                "detected": detected,
                "confidence": confidence,
                "variance": ssid_variances
            }


class ScanRunner:
    """Runs macos-wifi-scan in background thread."""
    
    def __init__(self, binary_path: str, history: RSSIHistory, interval: float = SCAN_INTERVAL):
        self.binary_path = binary_path
        self.history = history
        self.interval = interval
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.connected_ssid: Optional[str] = None
    
    def _run_scan(self) -> Dict[str, Any]:
        """Run the scan binary."""
        try:
            result = subprocess.run(
                [self.binary_path],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                return {"error": f"Scan failed: {result.stderr}", "networks": []}
            
            data = json.loads(result.stdout)
            self.connected_ssid = data.get("connected_ssid")
            return data
        except Exception as e:
            return {"error": str(e), "networks": []}
    
    def _scan_loop(self) -> None:
        """Background scan loop."""
        while self.running:
            try:
                scan_data = self._run_scan()
                
                # Extract networks as {ssid: rssi}
                networks: Dict[str, float] = {}
                for net in scan_data.get("networks", []):
                    ssid = net.get("ssid", "unknown")
                    rssi = net.get("rssi")
                    if rssi is not None:
                        networks[ssid] = rssi
                
                self.history.add_scan(networks, time.time())
            except Exception:
                pass
            
            # Sleep in small increments for responsive shutdown
            for _ in range(int(self.interval * 10)):
                if not self.running:
                    break
                time.sleep(0.1)
    
    def start(self) -> None:
        """Start the scan runner."""
        self.running = True
        self.thread = threading.Thread(target=self._scan_loop, daemon=True)
        self.thread.start()
    
    def stop(self) -> None:
        """Stop the scan runner."""
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)


class PresenceHandler(BaseHTTPRequestHandler):
    """HTTP handler for /api/v1/pose/current endpoint."""
    
    history: RSSIHistory = None  # Set by main()
    
    def do_GET(self):
        if self.path == "/api/v1/pose/current":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            presence = self.history.compute_presence()
            timestamp = time.time()
            
            result = {
                "timestamp": timestamp,
                "source": "macos-rssi",
                "total_persons": 1 if presence["detected"] else 0,
                "persons": []
            }
            
            if presence["detected"]:
                result["persons"] = [{
                    "id": 1,
                    "confidence": presence["confidence"],
                    "zone": "home"
                }]
            
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status": "ok"}')
        else:
            self.send_response(404)
            self.end_headers()
    
    def log_message(self, format, *args):
        """Suppress default logging."""
        pass


class QuietHTTPServer(HTTPServer):
    """HTTP server that suppresses console output."""
    def handle_error(self, request, client_address):
        pass  # Suppress error noise


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="RSSI Daemon for Hermes RuView Presence")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"HTTP port (default: {DEFAULT_PORT})")
    parser.add_argument("--binary", help="Path to macos-wifi-scan binary")
    args = parser.parse_args()
    
    # Find binary
    binary_path = args.binary
    if not binary_path:
        for path in DEFAULT_BINARY_PATHS:
            if os.path.exists(path):
                binary_path = path
                break
        if not binary_path:
            print(f"Error: macos-wifi-scan not found. Tried: {', '.join(DEFAULT_BINARY_PATHS)}", file=sys.stderr)
            sys.exit(1)
    
    # Initialize components
    history = RSSIHistory()
    scan_runner = ScanRunner(binary_path, history)
    
    # Setup signal handlers
    def signal_handler(signum, frame):
        print("\nShutting down...")
        scan_runner.stop()
        sys.exit(0)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start scanning
    scan_runner.start()
    
    # Start HTTP server
    PresenceHandler.history = history
    server = QuietHTTPServer(("localhost", args.port), PresenceHandler)
    
    print(f"RSSI Daemon running on http://localhost:{args.port}")
    print(f"Scanning every {SCAN_INTERVAL}s (macOS CoreWLAN rate limit)")
    print(f"Press Ctrl+C to stop")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scan_runner.stop()
        server.shutdown()


if __name__ == "__main__":
    main()