<p align="center">
  <img src="https://img.shields.io/badge/OpenClaw-Plugin-blueviolet?style=for-the-badge" alt="OpenClaw Plugin">
  <img src="https://img.shields.io/badge/RuView-WiFi%20Sensing-orange?style=for-the-badge" alt="RuView WiFi Sensing">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License">
</p>

# OpenClaw RuView Presence

**Presence-aware AI agents powered by WiFi sensing.** No cameras. No wearables. Just physics.

Your OpenClaw agents detect whether you're physically present using WiFi signals. When you leave, they queue messages. When you return, they greet you with a digest of everything that happened while you were away.

---

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
              | ruview-presence |     State machine:
              |   (this plugin) |     present -> away -> returned
              +-------+--------+
                      |
              +-------v--------+
              |    OpenClaw     |     Agents adapt behavior
              |    Agents       |     based on your presence
              +----------------+
```

| State | What Happens |
|:------|:-------------|
| **Present** | Agents operate normally |
| **Away** | Non-urgent messages are queued; urgent ones sent immediately |
| **Returned** | Agents deliver a welcome-back digest, then resume normal operation |

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

> Works in simulation mode out of the box — no WiFi hardware needed for testing. The `source` field in API responses will show `"simulate"` (synthetic data) vs `"csi"` (real hardware).

### 2. Install the Plugin

```bash
# From local clone
git clone https://github.com/DevvGwardo/openclaw-ruview-presence.git
openclaw plugins install ./openclaw-ruview-presence

# Or link for development
openclaw plugins install -l ./openclaw-ruview-presence
```

### 3. Configure

Add to your `openclaw.json`:

```jsonc
{
  // Plugin configuration (runtime logic)
  "plugins": {
    "entries": {
      "ruview-presence": {
        "enabled": true,
        "config": {
          "ruviewUrl": "http://localhost:3000",
          "confidenceThreshold": 0.3,
          "debounceCount": 2,
          "enableDigest": true
        }
      }
    }
  },

  // Skill configuration (agent instructions)
  "skills": {
    "entries": {
      "ruview-presence": {
        "enabled": true,
        "env": {
          "RUVIEW_API_URL": "http://localhost:3000"
        }
      }
    }
  }
}
```

### 4. Install the Bundled Skill

```bash
cp -r skills/ruview-presence ~/.openclaw/skills/ruview-presence
```

That's it. Your agents will start checking presence on their next heartbeat. You'll see this in the logs confirming the skill was picked up:

```
config change detected; evaluating reload (skills)
config change applied (dynamic reads: skills)
```

---

## Configuration Reference

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `ruviewUrl` | `string` | `http://localhost:3000` | RuView API base URL |
| `pollIntervalMs` | `number` | `10000` | How often to poll RuView (ms) |
| `confidenceThreshold` | `number` | `0.3` | Minimum detection confidence to count as "present" |
| `debounceCount` | `number` | `2` | Consecutive empty readings before marking as "away" |
| `enableDigest` | `boolean` | `true` | Show a summary digest when the user returns |
| `enableZoneAwareness` | `boolean` | `false` | Track which room/zone the user is in |

All options can also be set via environment variables:

| Environment Variable | Maps To |
|:---------------------|:--------|
| `RUVIEW_API_URL` | `ruviewUrl` |
| `RUVIEW_API_KEY` | Auth token (if RuView auth is enabled) |

---

## RuView API Data

These are the actual responses from RuView that the plugin works with.

### Pose Detection (`GET /api/v1/pose/current`)

This is the primary endpoint used for presence detection.

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
        { "name": "left_eye", "confidence": 0.61, "x": 326.1, "y": 146.0, "z": -0.22 },
        { "name": "right_eye", "confidence": 0.66, "x": 346.1, "y": 143.2, "z": -0.22 },
        { "name": "left_shoulder", "confidence": 0.77, "x": 311.3, "y": 185.6, "z": -0.22 },
        { "name": "right_shoulder", "confidence": 0.74, "x": 360.6, "y": 186.9, "z": -0.22 }
      ]
    }
  ]
}
```

Each person includes 17 DensePose-compatible keypoints: nose, left/right eye, left/right ear, left/right shoulder, left/right elbow, left/right wrist, left/right hip, left/right knee, left/right ankle.

### Zone Summary (`GET /api/v1/pose/zones/summary`)

```json
{
  "zones": {
    "zone_1": { "person_count": 1, "status": "monitored" },
    "zone_2": { "person_count": 0, "status": "clear" },
    "zone_3": { "person_count": 0, "status": "clear" },
    "zone_4": { "person_count": 0, "status": "clear" }
  }
}
```

### Vital Signs (`GET /api/v1/vital-signs`)

```json
{
  "vital_signs": {
    "breathing_rate_bpm": 9.4,
    "breathing_confidence": 0.83,
    "heart_rate_bpm": 44.4,
    "heartbeat_confidence": 0.67,
    "signal_quality": 0.52
  },
  "source": "simulate",
  "tick": 19612
}
```

### Full Sensing Data (`GET /api/v1/sensing/latest`)

Returns everything above plus raw signal features (mean RSSI, spectral power, motion/breathing band power), per-sensor subcarrier amplitudes, RF tomography voxel grid, and classification:

```json
{
  "classification": {
    "presence": true,
    "motion_level": "present_still",
    "confidence": 0.78
  },
  "features": {
    "mean_rssi": -37.0,
    "variance": 15.1,
    "spectral_power": 249.0,
    "dominant_freq_hz": 1.85,
    "breathing_band_power": 16.4,
    "motion_band_power": 13.7,
    "change_points": 8
  }
}
```

### Health Check (`GET /health/live`)

```json
{ "status": "alive", "uptime": 1961 }
```

---

## Architecture

### Plugin Layer (`index.ts`)

Hooks into OpenClaw's `before_prompt_build` lifecycle event to poll RuView and manage state transitions. When the user returns after being away, the plugin prepends a digest summary to the agent's context.

Types match the actual RuView API response format — `RuViewPoseResponse`, `RuViewZoneSummary`, `RuViewVitalSigns`, and `RuViewSensingLatest` are all typed to the real payloads.

### Skill Layer (`skills/ruview-presence/`)

Provides standing orders that agents follow during heartbeat cycles. The skill gives agents explicit instructions for presence-aware behavior — checking the API, interpreting results, and acting on state changes. Includes the actual JSON response format so agents can parse responses correctly.

### Gateway RPC Methods

The plugin exposes two methods on the OpenClaw gateway for programmatic access:

| Method | Returns |
|:-------|:--------|
| `ruview.presence` | `{ state, zone, awaySince, queuedEvents, detectedPersons, source }` |
| `ruview.queueEvent` | `{ queued: true, total: <count> }` |

---

## Hardware Options

RuView runs in simulation mode by default (`source: "simulate"` in responses). For real-world presence detection (`source: "csi"`):

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **No hardware** | Any computer | $0 | Simulation mode (synthetic data) |
| **Basic** | Any WiFi laptop | $0 | RSSI-only presence (coarse) |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat, motion |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |

---

## Fault Tolerance

- If RuView is unreachable, the plugin **keeps the last known state** and retries on the next heartbeat
- The debounce mechanism prevents false "away" triggers from momentary signal drops (requires 2 consecutive empty readings by default)
- Urgent messages are always delivered immediately, regardless of presence state
- The `source` field in RuView responses distinguishes simulation from real hardware data

---

## Troubleshooting

| Problem | Solution |
|:--------|:---------|
| Agent says "rate limit reached" | Your model provider is rate-limited. Switch to a different model with `openclaw models set <model>` |
| Agent tries to use `read()` tools | The Chat Completions API doesn't support tool calls. Send the agent the data directly or use the Responses API |
| Port 3000 is already in use | Map to a different port: `docker run -d -p 3002:3000 --name ruview ruvnet/wifi-densepose:latest` and update `ruviewUrl` in config |
| Skill not detected | Check `openclaw logs` for `config change detected; evaluating reload (skills)` — if missing, restart the gateway |
| Always shows "present" | In simulation mode, RuView always returns a synthetic person. Use real CSI hardware for actual presence/absence detection |

---

## Project Structure

```
openclaw-ruview-presence/
  index.ts                 Plugin entry point (state machine, polling, digest)
  openclaw.plugin.json     Plugin manifest and config schema
  package.json             Package definition
  skills/
    ruview-presence/
      SKILL.md             Agent standing orders with API response formats
      HEARTBEAT.md         Heartbeat trigger
```

---

## Requirements

- [OpenClaw](https://openclaw.com) agent runtime (`>=2026.3.1`)
- [RuView](https://github.com/ruvnet/RuView) sensing server (Docker or native)

## Hermes Port

A Hermes-native implementation lives in the `hermes/` subdirectory. It uses a pure-stdlib Python state machine, a shell cron wrapper, and a skill for agent standing orders. State persists to `~/.hermes/memories/hermes-ruview-presence-state.json`. See `hermes/README.md` for full setup instructions.

---

## License

MIT

---

<p align="center">
  <sub>Built with <a href="https://github.com/ruvnet/RuView">RuView</a> WiFi sensing and <a href="https://openclaw.com">OpenClaw</a> agent runtime.</sub>
</p>
