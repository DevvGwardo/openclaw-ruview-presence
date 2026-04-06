# Hermes RuView Presence

**Presence-aware AI agent powered by WiFi sensing.** No cameras. No wearables. Just physics.

This is the Hermes adaptation of the [OpenClaw ruview-presence](https://github.com/MisterGuy420/openclaw-ruview-presence) plugin. It uses RuView's Channel State Information (CSI) WiFi sensing to detect whether you're physically present, queues messages while you're away, and greets you with a digest when you return.

---

## How It Works

```
WiFi Signals
    |
GET /api/v1/pose/current
    |
+---v---+       +--------+       +--------+
| RuView|--CSI--> Hermes |State: | present |
| CSI   |       | State  |       | away   |
+--------+       +---+----+       | returned|
                    |             +--------+
              ~/.hermes/memories/
              ruview-presence-state.json
```

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

Verify it's running:

```bash
curl -s http://localhost:3000/health/live
# {"status":"alive","uptime":4}
```

Works in simulation mode out of the box. `source` field shows `"simulate"` (synthetic) vs `"csi"` (real hardware).

### 2. Install the Scripts

```bash
# State machine
cp ~/hermes-evo/scripts/ruview_state.py ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/ruview_state.py

# Cron wrapper
cp ~/hermes-evo/scripts/ruview-presence-cron.sh ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/ruview-presence-cron.sh

# Skill (agent instructions)
cp -r ~/hermes-evo/scripts/skills/ruview-presence ~/.hermes/skills/
```

### 3. Configure

Create `~/.hermes/memories/.ruview-env`:

```bash
RUVIEW_API_URL=http://localhost:3000
RUVIEW_API_KEY=
RUVIEW_CONFIDENCE_THRESHOLD=0.3
RUVIEW_DEBOUNCE_COUNT=2
```

### 4. Cron Job

The cron job is auto-registered via `~/.hermes/cron/jobs.json`. It runs every 30 seconds and updates presence state in `~/.hermes/memories/ruview-presence-state.json`.

To manually trigger the polling script:

```bash
~/.hermes/scripts/ruview-presence-cron.sh
```

---

## State File

`~/.hermes/memories/ruview-presence-state.json`

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

---

## Configuration Reference

| Env Variable | Default | Description |
|:-------------|:--------|:------------|
| `RUVIEW_API_URL` | `http://localhost:3000` | RuView API base URL |
| `RUVIEW_API_KEY` | _(none)_ | Bearer token if auth enabled |
| `RUVIEW_CONFIDENCE_THRESHOLD` | `0.3` | Min confidence to count as present |
| `RUVIEW_DEBOUNCE_COUNT` | `2` | Empty checks before marking away |

---

## Agent Skill

When the `ruview-presence` skill is active, Hermes agents follow these standing orders on every conversation start:

1. Read `~/.hermes/memories/ruview-presence-state.json`
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
hermes-evo/scripts/
  ruview_state.py              State machine + API polling (pure stdlib)
  ruview-presence-cron.sh      Cron wrapper + env loading
  skills/ruview-presence/
    SKILL.md                   Agent standing orders
```

State persists across sessions via JSON file in `~/.hermes/memories/`.

---

## RuView API

Primary endpoint: `GET /api/v1/pose/current`

```json
{
  "timestamp": 1773088911.824,
  "source": "simulate",
  "total_persons": 1,
  "persons": [
    {
      "id": 1,
      "confidence": 0.78,
      "zone": "zone_1",
      "bbox": { "x": 270.4, "y": 133.2, "width": 136.6, "height": 235.1 },
      "keypoints": [
        { "name": "nose", "confidence": 0.59, "x": 336.5, "y": 151.8, "z": -0.22 },
        ...
      ]
    }
  ]
}
```

---

## Hardware Options

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **None** | Any computer | $0 | Simulation mode |
| **Basic** | Any WiFi laptop | $0 | RSSI-only presence |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |

---

## License

MIT
