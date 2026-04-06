# Hermes RuView Presence

<p align="center">
  <img src="https://img.shields.io/badge/Hermes-AI%20Agent-teal?style=for-the-badge" alt="Hermes AI Agent">
  <img src="https://img.shields.io/badge/RuView-WiFi%20Sensing-orange?style=for-the-badge" alt="RuView WiFi Sensing">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License">
</p>

**Presence-aware AI agent powered by WiFi sensing. No cameras. No wearables. Just physics.**

A Hermes AI agent skill that uses RuView Channel State Information (CSI) WiFi sensing to detect whether you're physically present. When you leave, it queues messages. When you return, it greets you with a digest of everything that happened.

## How It Works

```
              WiFi Signals
                  |
          +-------v--------+
          |    RuView      |     Detects presence via
          | WiFi Sensing   |     Channel State Information (CSI)
          +-------+--------+
                  |
          GET /api/v1/pose/current
                  |
          +-------v--------+
          | Hermes State   |     State machine:
          |   Machine      |     present -> away -> returned
          +-------+--------+
                  |
          +-------v--------+
          |  Hermes Agent   |     Adapts behavior based on
          |                 |     your presence state
          +-----------------+
```

## State Machine

| State | Description |
|:------|:------------|
| **present** | User is in the room. Normal agent operation. |
| **away** | User left (debounce triggered). Non-urgent messages are queued. |
| **returned** | User just came back. Agent delivers a digest of queued events, then resumes normal operation. |

## Quick Start

### 1. Start RuView

```bash
docker run -d -p 3000:3000 --name ruview ruvnet/wifi-densepose:latest
```

Verify it's running:

```bash
curl -s http://localhost:3000/health/live
# {"status":"alive","uptime":4}
```

> Works in simulation mode out of the box - no WiFi hardware needed for testing. The `source` field in API responses shows `"simulate"` (synthetic data) vs `"csi"` (real hardware).

### 2. Install Scripts

```bash
cp ~/openclaw-ruview-presence/hermes/scripts/ruview_state.py ~/.hermes/scripts/
cp ~/openclaw-ruview-presence/hermes/scripts/hermes-ruview-presence-cron.sh ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/hermes-ruview-presence-cron.sh
```

### 3. Configure Environment

Create `~/.hermes/memories/.hermes-ruview-env`:

```
RUVIEW_API_URL=http://localhost:3000
RUVIEW_API_KEY=
RUVIEW_CONFIDENCE_THRESHOLD=0.3
RUVIEW_DEBOUNCE_COUNT=2
```

### 4. Install the Skill

```bash
cp -r ~/openclaw-ruview-presence/hermes/skills/hermes-ruview-presence ~/.hermes/skills/
```

### 5. Start the Cron Job

The cron job auto-registers and runs every 30 seconds:

```bash
# Add to crontab
*/30 * * * * ~/.hermes/scripts/hermes-ruview-presence-cron.sh

# Or run manually to test
~/.hermes/scripts/hermes-ruview-presence-cron.sh
```

## State File

Location: `~/.hermes/memories/hermes-ruview-presence-state.json`

```json
{
  "current_state": "present",
  "previous_state": "",
  "away_since": null,
  "empty_check_count": 0,
  "last_poll": 1773088911.824,
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
| `away_since` | number | Unix timestamp when user became away |
| `empty_check_count` | number | Consecutive empty readings (for debounce) |
| `last_poll` | number | Unix timestamp of last API poll |
| `last_source` | string | Data source: `simulate` or `csi` |
| `detected_persons` | number | Number of persons detected |
| `event_queue` | array | Queued events while away |
| `pending_digest` | boolean | Whether a digest is pending delivery |

## Configuration Reference

| Variable | Default | Description |
|:---------|:--------|:------------|
| `RUVIEW_API_URL` | `http://localhost:3000` | RuView API base URL |
| `RUVIEW_API_KEY` | _(empty)_ | Auth token (if RuView auth is enabled) |
| `RUVIEW_CONFIDENCE_THRESHOLD` | `0.3` | Minimum confidence to count as present |
| `RUVIEW_DEBOUNCE_COUNT` | `2` | Empty readings before marking away |

## Agent Skill

On every conversation start, Hermes reads `hermes-ruview-presence-state.json` and follows these standing orders:

1. If `current_state` is `"returned"` and `pending_digest` is `true`: deliver the digest as the first message, then set `pending_digest: false` and `current_state: "present"`
2. If `current_state` is `"away"`: queue non-urgent outbound messages in the `event_queue` list
3. If RuView is unreachable: use the last known state from the state file

### Digest Format

When returning, Hermes delivers:

```
Welcome back! You were away for {duration}.

While you were away:
- {N} message(s) queued (channels)
- {N} task(s) updated
- {urgent_count} urgent item(s) sent immediately

Ready when you are.
```

## Project Structure

```
hermes/
  scripts/
    ruview_state.py                    Presence state machine
    hermes-ruview-presence-cron.sh     Cron wrapper script
  skills/
    hermes-ruview-presence/
      SKILL.md                         Agent standing orders
```

## Hardware Options

RuView runs in simulation mode by default (`source: "simulate"` in responses). For real-world presence detection (`source: "csi"`):

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **No hardware** | Any computer | $0 | Simulation mode (synthetic data) |
| **Basic** | Any WiFi laptop | $0 | RSSI-only presence (coarse) |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat, motion |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |
| **macOS** | MacBook (native) | $0 | RSSI-only, ~0.3-0.5 Hz, presence + motion detection |

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

## License

MIT
