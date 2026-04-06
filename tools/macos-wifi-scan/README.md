# macOS WiFi Scan

CoreWLAN-based WiFi RSSI scanner for macOS. Returns JSON with visible networks, signal strength, noise floor, and channel — no extra hardware required.

## Build

```
./build.sh
```

Requires Xcode Command Line Tools (`xcode-select --install`).

## Run

```bash
# All visible networks
./macos-wifi-scan

# Check availability
./macos-wifi-scan --probe

# Connected network only
./macos-wifi-scan --connected
```

## Output Format

```json
[
  {
    "ssid": "MyNetwork",
    "rssi": -38,
    "noise": -85,
    "channel": 6,
    "bssid": "aa1122ccdd44"
  }
]
```

## Permissions

Location Services must be enabled for full SSID access. Without it, BSSIDs are returned as SHA256 pseudo-identifiers (`ssid:channel` hashed). RSSI values always work.

## Requirements

- macOS 10.15+
- WiFi enabled
- Xcode Command Line Tools
