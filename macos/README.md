# macOS RSSI Adapter for Hermes RuView Presence

Bridges macOS WiFi scan data to the Hermes RuView presence state machine using real MacBook RSSI data—no ESP32 hardware required.

## How It Works

**Key insight (ADR-025): RSSI variance = motion = presence**

The macOS CoreWLAN framework can scan for visible WiFi networks and report their RSSI (signal strength) values. When someone moves in a room, their body affects the WiFi signal propagation, causing RSSI fluctuations across visible networks.

This adapter:
1. Runs `macos-wifi-scan` to get visible SSIDs and RSSI values
2. Tracks RSSI history over time
3. Computes running variance—if variance exceeds threshold, someone is moving
4. Falls back to baseline detection (connected network RSSI above noise floor)

## Setup

### Prerequisites

- macOS with CoreWLAN framework (requires macOS)
- Swift 5.x for building the scan binary
- Python 3.6+

### Build the Swift Binary

```bash
cd ~/openclaw-ruview-presence/tools/macos-wifi-scan
./build.sh
```

This builds `macos-wifi-scan` and installs it to `/usr/local/bin/macos-wifi-scan`.

### Run the Daemon

```bash
cd ~/openclaw-ruview-presence
./macos/start_rssi_daemon.sh
```

The script will:
1. Build the Swift binary if not already built
2. Start `rssi_daemon.py` in background
3. Save PID to `~/.hermes/run/macos-rssi-daemon.pid`
4. Log to `~/.hermes/logs/macos-rssi-daemon.log`

### Configure Hermes

Add to your `.hermes-ruview-env` file:

```bash
export RUVIEW_API_URL=http://localhost:3002
```

The RSSI daemon serves the same `/api/v1/pose/current` format that Hermes expects, but on port 3002 instead of 3000.

### Verify

```bash
curl http://localhost:3002/api/v1/pose/current
```

Should return:
```json
{
  "timestamp": 1234567890.0,
  "source": "macos-rssi",
  "total_persons": 1,
  "persons": [
    {
      "id": 1,
      "confidence": 0.7,
      "zone": "home"
    }
  ]
}
```

## Files

| File | Description |
|------|-------------|
| `rssi_adapter.py` | Single-shot adapter—runs scan once, outputs JSON |
| `rssi_daemon.py` | Long-running daemon—scans every 2-3s, serves HTTP |
| `start_rssi_daemon.sh` | Shell wrapper—builds binary, manages daemon lifecycle |
| `README.md` | This file |

## Detection Algorithm

### Variance-Based Detection

When RSSI values across visible networks show significant variance (stddev > 3 dBm), someone is likely moving in the room. Higher variance = higher confidence.

### Baseline Detection

If all networks are stable but the connected network has RSSI above the noise floor (-85 dBm), someone is probably near the router.

### Confidence Scoring

| Condition | Confidence |
|-----------|------------|
| High RSSI variance (>6 dBm) | 0.8 - 1.0 |
| Moderate RSSI variance (3-6 dBm) | 0.3 - 0.8 |
| Baseline (stable, above noise) | 0.5 |

## Limitations

- **Scan rate**: ~0.3-0.5 Hz (macOS CoreWLAN rate limiting)
- **RSSI-only**: No pose estimation or breathing detection
- **Detection only**: Cannot distinguish between multiple people
- **Environmental sensitivity**: WiFi congestion can affect readings

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   macOS WiFi    │────▶│  rssi_daemon.py  │────▶│  Hermes         │
│   CoreWLAN      │     │  (HTTP server)   │     │  ruview_state.py│
│   (macos-wifi)  │     │  port 3002       │     │  (polls API)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                        │
        │ RSSI scan              │ /api/v1/pose/current
        ▼                        ▼
   ┌─────────┐            ┌─────────────┐
   │ Visible │◀──hist───▶│ RSSI        │
   │ SSIDs   │            │ History     │
   │ + RSSI  │            │ (10 scans)  │
   └─────────┘            └─────────────┘
```

## Troubleshooting

### Daemon won't start

Check the log file:
```bash
tail -f ~/.hermes/logs/macos-rssi-daemon.log
```

### Binary not found

Build manually:
```bash
cd ~/openclaw-ruview-presence/tools/macos-wifi-scan
swift build
cp .build/Debug/macos-wifi-scan /usr/local/bin/
```

### Permission denied

The WiFi scan may require elevated privileges on some macOS versions. Try running with sudo (not recommended for production).