# Hermes RuView Presence

![Hermes](https://img.shields.io/badge/Hermes-00C9A7?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI0NSIgZmlsbD0iIzAwQzlBNyIvPjwvc3ZnPg==)
![RuView](https://img.shields.io/badge/RuView-FF6B35?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI0NSIgZmlsbD0iI0ZGNkIzNSIvPjwvc3ZnPg==)
![MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)

**Presence-aware AI agent powered by WiFi sensing.** No cameras. No wearables. Just physics.

A Hermes adaptation of the [OpenClaw ruview-presence](https://github.com/MisterGuy420/openclaw-ruview-presence) plugin. Uses RuView Channel State Information (CSI) WiFi sensing to detect whether you're physically present, queues messages while you're away, and greets you with a digest when you return.

---

## How It Works

```
WiFi Signals
    |
GET /api/v1/pose/current
    |
+---v---+       +--------+       +--------+
| RuView|--CSI->| Hermes |State: | present |
| CSI   |       | State  |       | away    |
+--------+      +---+----+       | returned|
                     |           +--------+
               ~/.hermes/memories/
               hermes-ruview-presence-state.json
```

**State machine:**

| State | What Happens |
|:------|:-------------|
| **present** | Normal operation |
| **away** | Non-urgent messages queued |
| **returned** | Welcome-back digest delivered |

---

## Quick Start

### 1. Start RuView

```bash
docker run -d -p 3000:3000 --name ruview ruvnet/wifi-densepose:latest
```

Verify:

```bash
curl -s http://localhost:3000/health/live
# {"status":"alive","uptime":4}
```

Works in simulation mode out of the box. `source: "simulate"` = synthetic data, `source: "csi"` = real hardware.

### 2. Install the Scripts

```bash
# State machine
cp hermes/scripts/ruview_state.py ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/ruview_state.py

# Cron wrapper
cp hermes/scripts/hermes-ruview-presence-cron.sh ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/hermes-ruview-presence-cron.sh

# Skill (agent instructions)
cp -r hermes/skills/hermes-ruview-presence ~/.hermes/skills/
```

### 3. Configure

Create `~/.hermes/memories/.hermes-ruview-env`:

```bash
RUVIEW_API_URL=http://localhost:3000
RUVIEW_API_KEY=
RUVIEW_CONFIDENCE_THRESHOLD=0.3
RUVIEW_DEBOUNCE_COUNT=2
```

### 4. Cron Job

The cron job auto-registers in `~/.hermes/cron/jobs.json` (runs every 30 seconds). Manually trigger:

```bash
~/.hermes/scripts/hermes-ruview-presence-cron.sh
```

---

## State File

`~/.hermes/memories/hermes-ruview-presence-state.json`

```json
{
  "current_state": "present",
  "previous_state": "",
  "away_since": null,
  "empty_check_count": 0,
  "last_poll": 1234567890.0,
  "last_source": "simulate",
  "detected_persons": 1,
  "event_queue": [],
  "pending_digest": false
}
```

| Field | Type | Description |
|:------|:-----|:------------|
| `current_state` | string | Current state: `present`, `away`, or `returned` |
| `previous_state` | string | Previous state before last transition |
| `away_since` | float\|null | Unix timestamp when user went away |
| `empty_check_count` | int | Consecutive empty polls (used for debounce) |
| `last_poll` | float | Unix timestamp of last poll |
| `last_source` | string\|null | Data source: `simulate`, `csi`, etc. |
| `detected_persons` | int | Number of persons detected |
| `event_queue` | array | Queued events accumulated while away |
| `pending_digest` | bool | Whether digest is pending delivery |

---

## Configuration Reference

| Env Variable | Default | Description |
|:-------------|:--------|:------------|
| `RUVIEW_API_URL` | `http://localhost:3000` | RuView API base URL |
| `RUVIEW_API_KEY` | _(none)_ | Bearer token if auth enabled |
| `RUVIEW_CONFIDENCE_THRESHOLD` | `0.3` | Min confidence to count as present |
| `RUVIEW_DEBOUNCE_COUNT` | `2` | Empty polls before marking away |

---

## Agent Skill

When the `hermes-ruview-presence` skill is active, Hermes follows these standing orders on every conversation start:

1. Read `~/.hermes/memories/hermes-ruview-presence-state.json`
2. If `current_state` is `"returned"` and `pending_digest` is `true`: deliver digest, clear digest flag, set state to `"present"`
3. If `current_state` is `"away"`: queue non-urgent messages to the `event_queue` list in the state file
4. If RuView is unreachable: use last known state, do not change it

### Digest Format

```
Welcome back! You were away for 12m.

While you were away:
- 3 message(s) queued (discord: 2, telegram: 1)
- 1 task(s) updated

Ready when you are.
```

---

## Project Structure

```
hermes/
├── README.md                              This file
├── scripts/
│   ├── ruview_state.py                    State machine + API polling (pure stdlib)
│   └── hermes-ruview-presence-cron.sh     Cron wrapper + env loading
└── skills/hermes-ruview-presence/
    └── SKILL.md                           Agent standing orders
```

---

## Hardware Options

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **None** | Any computer | $0 | Simulation mode |
| **Basic** | Any WiFi laptop | $0 | RSSI-only presence |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |
| **macOS** | MacBook (native) | $0 | RSSI-only, ~0.3-0.5 Hz, presence + motion detection |

---

## macOS Setup

For macOS users with MacBooks, an RSSI-based daemon provides presence detection using native CoreWLAN (no extra hardware).

### Requirements

- macOS with WiFi adapter
- Location Services enabled (required for BSSID access)
- Xcode command line tools

### Setup Steps

**a. Build the Swift scanner:**

```bash
cd tools/macos-wifi-scan && ./build.sh
```

**b. Start the RSSI daemon:**

```bash
./macos/start_rssi_daemon.sh
```

The daemon polls RSSI every 2-3s, computes variance, and serves the RuView API format on `http://localhost:3002`.

**c. Configure Hermes to use the RSSI endpoint:**

Edit `~/.hermes/memories/.hermes-ruview-env`:

```bash
RUVIEW_API_URL=http://localhost:3002
```

**d. Verify installation:**

```bash
curl -s http://localhost:3002/api/v1/pose/current | python3 -c "import sys,json; d=json.load(sys.stdin); print('source:', d['source'], 'persons:', d['total_persons'])"
```

Expected output: `source: macos-rssi persons: 0` (1 if you're moving)

### Limitations

- RSSI-only: no pose estimation or person counting
- Update rate: ~0.3-0.5 Hz (2-3 second polling)
- Requires Location Services to be enabled for BSSID scanning
- Coarse presence detection based on RSSI variance

---

## License

MIT
