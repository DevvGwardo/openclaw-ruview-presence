#!/usr/bin/env python3
"""
RSSI Adapter for Hermes RuView Presence
Bridges macOS WiFi scan data to Hermes RuView state machine.

Key insight (ADR-025): RSSI variance = motion = presence.
You don't need absolute RSSI, you need to detect when RSSI values change over time.

Usage:
    python3 rssi_adapter.py [--binary PATH]
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Any, Optional

# Configuration
DEFAULT_BINARY_PATHS = [
    "/usr/local/bin/macos-wifi-scan",
    str(Path(__file__).parent.parent / "tools/macos-wifi-scan/macos-wifi-scan"),
]
RSSI_HISTORY_SIZE = 10
VARIANCE_THRESHOLD = 3.0  # dBm stddev - if RSSI varies more than this, someone is moving
NOISE_FLOOR = -85  # dBm - connected network above this = someone near router
BASELINE_CONFIDENCE = 0.5  # When stable but above noise floor


class RSSIAdapter:
    def __init__(self, binary_path: Optional[str] = None):
        self.binary_path = binary_path or self._find_binary()
        self.history: List[Dict[str, Any]] = []
        
    def _find_binary(self) -> str:
        """Find the macos-wifi-scan binary."""
        for path in DEFAULT_BINARY_PATHS:
            if os.path.exists(path):
                return path
        raise FileNotFoundError(
            f"macos-wifi-scan not found. Tried: {', '.join(DEFAULT_BINARY_PATHS)}"
        )
    
    def _run_scan(self) -> Dict[str, Any]:
        """Run the macos-wifi-scan binary and return parsed JSON.

        Swift returns a JSON array of networks.
        We wrap it into the dict format expected by _compute_presence.
        """
        try:
            result = subprocess.run(
                [self.binary_path],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                raise RuntimeError(f"Scan failed with code {result.returncode}: {result.stderr}")
            raw = json.loads(result.stdout)

            # Swift returns a list; wrap into expected dict format
            if isinstance(raw, list):
                networks = raw
            elif isinstance(raw, dict):
                networks = raw.get("networks", [])
            else:
                networks = []

            return {"networks": networks}
        except subprocess.TimeoutExpired:
            raise RuntimeError("Scan timed out")
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid JSON from scan: {e}")
    
    def _compute_variance(self, values: List[float]) -> float:
        """Compute standard deviation of a list of values."""
        if len(values) < 2:
            return 0.0
        mean = sum(values) / len(values)
        variance = sum((x - mean) ** 2 for x in values) / len(values)
        return variance ** 0.5
    
    def _compute_presence(self, scan_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Compute presence detection from scan data.
        
        Strategy:
        1. Track RSSI history for each SSID over time
        2. If any network's RSSI varies significantly (stddev > threshold), someone is moving
        3. If all stable, use baseline detection (connected network RSSI above noise floor)
        """
        networks = scan_data.get("networks", [])
        current_time = time.time()
        
        # Build current RSSI map: {ssid: rssi}
        current_rssi: Dict[str, float] = {}
        for net in networks:
            ssid = net.get("ssid", "unknown")
            rssi = net.get("rssi")
            if rssi is not None:
                current_rssi[ssid] = rssi
        
        # Update history with current readings
        self.history.append({
            "timestamp": current_time,
            "networks": current_rssi
        })
        
        # Keep only recent history
        while len(self.history) > RSSI_HISTORY_SIZE:
            self.history.pop(0)
        
        # Compute variance for each SSID across history
        ssid_variances: Dict[str, float] = {}
        for ssid in current_rssi:
            rssi_values = []
            for snapshot in self.history:
                if ssid in snapshot.get("networks", {}):
                    rssi_values.append(snapshot["networks"][ssid])
            if len(rssi_values) >= 2:
                ssid_variances[ssid] = self._compute_variance(rssi_values)
        
        # Detection logic
        detected = False
        confidence = 0.0
        
        # Check 1: High variance = motion detected
        for ssid, var in ssid_variances.items():
            if var > VARIANCE_THRESHOLD:
                detected = True
                # Higher variance = higher confidence (max at 1.0)
                var_confidence = min(1.0, var / (VARIANCE_THRESHOLD * 2))
                confidence = max(confidence, var_confidence)
        
        # Check 2: Baseline detection - connected network above noise floor
        if not detected:
            connected_ssid = scan_data.get("connected_ssid")
            if connected_ssid and connected_ssid in current_rssi:
                rssi = current_rssi[connected_ssid]
                if rssi > NOISE_FLOOR:
                    detected = True
                    confidence = BASELINE_CONFIDENCE
        
        return {
            "detected": detected,
            "confidence": confidence,
            "variance": ssid_variances,
            "networks": len(networks),
            "source": "macos-rssi"
        }
    
    def run_once(self) -> Dict[str, Any]:
        """Run a single scan and return presence result."""
        scan_data = self._run_scan()
        presence = self._compute_presence(scan_data)
        
        result = {
            "timestamp": time.time(),
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
        
        return result


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="RSSI Adapter for Hermes RuView Presence")
    parser.add_argument("--binary", help="Path to macos-wifi-scan binary")
    args = parser.parse_args()
    
    # Handle signals gracefully
    def signal_handler(signum, frame):
        sys.exit(0)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    try:
        adapter = RSSIAdapter(binary_path=args.binary)
        result = adapter.run_once()
        print(json.dumps(result, indent=2))
    except Exception as e:
        error_result = {
            "timestamp": time.time(),
            "source": "macos-rssi",
            "total_persons": 0,
            "persons": [],
            "error": str(e)
        }
        print(json.dumps(error_result, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()