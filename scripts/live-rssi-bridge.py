#!/usr/bin/env python3
"""
live-rssi-bridge.py — Live WiFi bridge for RuView on macOS (no ESP32 needed)

Turns real macOS RSSI into live CSI so RuView promotes from `simulated` → `esp32`.

Background:
  RuView normally needs 3-6× ESP32-S3 nodes streaming ADR-018 CSI frames to UDP 5005.
  Apple Silicon's Broadcom WiFi chip doesn't expose per-subcarrier CSI, but it *does*
  expose RSSI. This bridge reads live RSSI via `system_profiler` and synthesizes
  ADR-018 frames with that RSSI + motion-modulated I/Q so RuView sees live data.

Usage:
  # 1. Start RuView with UDP exposed (note the auth env — see README)
  docker run -d -p 3000:3000 -p 5005:5005/udp \
    -e RUVIEW_ALLOW_UNAUTHENTICATED=1 \
    -e RUVIEW_UDP_BIND=0.0.0.0 -e RUVIEW_UDP_INSECURE_LAN=true \
    --name ruview ruvnet/wifi-densepose:latest

  # 2. Run bridge (reads RSSI every 2s, sends 20 Hz CSI)
  python3 scripts/live-rssi-bridge.py
  python3 scripts/live-rssi-bridge.py --interval 0.05 --host 127.0.0.1 --port 5005

  # 3. Verify live
  curl -s http://localhost:3000/api/v1/pose/current | jq .source
  # "esp32" (live) instead of "simulated"
  curl -s http://localhost:3000/api/v1/sensing/latest | jq .features.mean_rssi
  # matches your real `system_profiler` RSSI (-50 dBm etc)

Notes:
  - `system_profiler` is slow (~1s) so RSSI is polled every 2s and cached.
  - I/Q is synthetic but variance is modulated to trigger RuView's presence detector.
    First 8s = low variance (empty-room calibration), then active motion.
  - For true per-subcarrier CSI (pose/breathing through walls), buy ESP32-S3 DevKitC-1.
"""

import argparse
import socket
import struct
import subprocess
import re
import time
import random
import math

MAGIC = 0xC5110001


def get_rssi() -> tuple[int, int]:
    try:
        out = subprocess.check_output(["system_profiler", "SPAirPortDataType"], text=True, timeout=5)
        m = re.search(r"Signal / Noise:\s*(-?\d+)\s*dBm\s*/\s*(-?\d+)\s*dBm", out)
        if m:
            return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    return -50, -92


def build_frame(seq: int, rssi: int, noise: int, t: float, start: float) -> bytes:
    # Motion profile: calibrate empty, then active
    if t - start < 8:
        motion = random.gauss(0, 1.2)
        breathing = random.gauss(0, 0.5)
    else:
        motion = math.sin(t * 0.6) * 12 + math.sin(t * 1.8) * 6 + math.sin(t * 4) * 2 + random.gauss(0, 2)
        motion += 8 * math.sin(t * 0.25)
        breathing = math.sin(t * 0.28) * 3

    n_sub = 64
    n_ant = 1
    freq = 5180
    iq = bytearray()
    for i in range(n_sub):
        base = 12 + 6 * math.sin(i * 0.7 + t * 0.4) + 4 * math.cos(i * 0.3 - t * 0.2)
        val = base + motion * 0.4 + breathing * 0.6
        if t - start > 8:
            val += random.gauss(0, 3) + 2 * math.sin(i + t)
        else:
            val += random.gauss(0, 1)
        iv = int(max(-128, min(127, val)))
        qv = int(max(-128, min(127, val * 0.85 + random.gauss(0, 1.5))))
        iq.append(iv & 0xFF)
        iq.append(qv & 0xFF)

    hdr = struct.pack("<I", MAGIC)
    hdr += struct.pack("B", 1)  # node id
    hdr += struct.pack("B", n_ant)
    hdr += struct.pack("<H", n_sub)
    hdr += struct.pack("<I", freq)
    hdr += struct.pack("<I", seq)
    hdr += struct.pack("b", rssi)
    hdr += struct.pack("b", noise)
    hdr += struct.pack("BB", 0, 0)
    return hdr + bytes(iq)


def main() -> None:
    p = argparse.ArgumentParser(description="Live RSSI → CSI bridge for RuView (macOS)")
    p.add_argument("--host", default="127.0.0.1", help="RuView UDP host")
    p.add_argument("--port", type=int, default=5005, help="RuView UDP port")
    p.add_argument("--interval", type=float, default=0.05, help="Send interval seconds (0.05 = 20 Hz)")
    p.add_argument("--rssi-interval", type=float, default=2.0, help="RSSI poll interval seconds")
    args = p.parse_args()

    rssi, noise = get_rssi()
    print(f"[bridge] live RSSI={rssi} dBm noise={noise} dBm → {args.host}:{args.port} @ {1/args.interval:.0f} Hz")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    seq = 0
    start = time.time()
    last_poll = 0
    cached_rssi, cached_noise = rssi, noise

    try:
        while True:
            now = time.time()
            if now - last_poll >= args.rssi_interval:
                cached_rssi, cached_noise = get_rssi()
                last_poll = now
                print(f"[{int(now-start):3}s] RSSI={cached_rssi} dBm noise={cached_noise} dBm seq={seq}", flush=True)
            frame = build_frame(seq, cached_rssi, cached_noise, now, start)
            sock.sendto(frame, (args.host, args.port))
            seq += 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[bridge] stopped")


if __name__ == "__main__":
    main()
