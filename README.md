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

> Works in simulation mode out of the box — no WiFi hardware needed for testing.

### 2. Install the Plugin

```bash
# From local clone
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

That's it. Your agents will start checking presence on their next heartbeat.

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

## Architecture

### Plugin Layer (`index.ts`)

Hooks into OpenClaw's `before_prompt_build` lifecycle event to poll RuView and manage state transitions. When the user returns after being away, the plugin prepends a digest summary to the agent's context.

### Skill Layer (`skills/ruview-presence/`)

Provides standing orders that agents follow during heartbeat cycles. The skill gives agents explicit instructions for presence-aware behavior — checking the API, interpreting results, and acting on state changes.

### Gateway RPC Methods

The plugin exposes two methods on the OpenClaw gateway for programmatic access:

```
ruview.presence       Returns { state, zone, awaySince, queuedEvents }
ruview.queueEvent     Queue an event for the return digest
```

### RuView Endpoints Used

| Endpoint | Purpose |
|:---------|:--------|
| `GET /api/v1/pose/current` | Detect persons and confidence scores |
| `GET /api/v1/pose/zones/summary` | Zone-level occupancy (when zone awareness is enabled) |
| `GET /health/live` | Verify RuView is reachable |

---

## Hardware Options

RuView runs in simulation mode by default. For real-world presence detection:

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **No hardware** | Any computer | $0 | Simulation mode (synthetic data) |
| **Basic** | Any WiFi laptop | $0 | RSSI-only presence (coarse) |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat, motion |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |

---

## Fault Tolerance

- If RuView is unreachable, the plugin **keeps the last known state** and retries on the next heartbeat
- The debounce mechanism prevents false "away" triggers from momentary signal drops
- Urgent messages are always delivered immediately, regardless of presence state

---

## Project Structure

```
openclaw-ruview-presence/
  index.ts                 Plugin entry point (state machine, polling, digest)
  openclaw.plugin.json     Plugin manifest and config schema
  package.json             Package definition
  skills/
    ruview-presence/
      SKILL.md             Agent standing orders
      HEARTBEAT.md         Heartbeat trigger
```

---

## Requirements

- [OpenClaw](https://openclaw.com) agent runtime (`>=2026.3.1`)
- [RuView](https://github.com/ruvnet/RuView) sensing server (Docker or native)

## License

MIT

---

<p align="center">
  <sub>Built with <a href="https://github.com/ruvnet/RuView">RuView</a> WiFi sensing and <a href="https://openclaw.com">OpenClaw</a> agent runtime.</sub>
</p>
