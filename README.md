# openclaw-ruview-presence

OpenClaw plugin for presence-aware agent behavior powered by [RuView](https://github.com/ruvnet/RuView) WiFi sensing.

## What it does

Your OpenClaw agents detect whether you're physically present using WiFi signals — no cameras, no wearables. When you leave, agents queue non-urgent messages. When you return, they greet you with a digest of everything that happened while you were away.

**State machine:** `present` → `away` → `returned` → `present`

| State | Behavior |
|-------|----------|
| **Present** | Normal agent operation |
| **Away** | Queue non-urgent messages, send urgent ones immediately |
| **Returned** | Deliver digest summary, flush queue, resume normal |

## Requirements

- [RuView](https://github.com/ruvnet/RuView) running locally (Docker or native)
- [OpenClaw](https://openclaw.com) agent runtime

## Quick start

### 1. Start RuView

```bash
docker run -d -p 3000:3000 --name ruview ruvnet/wifi-densepose:latest
```

### 2. Install the plugin

```bash
openclaw plugins install /path/to/openclaw-ruview-presence
```

Or link for development:

```bash
openclaw plugins install -l /path/to/openclaw-ruview-presence
```

### 3. Enable in openclaw.json

```json
{
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
  }
}
```

### 4. Install the skill

Copy the bundled skill to your OpenClaw skills directory:

```bash
cp -r skills/ruview-presence ~/.openclaw/skills/ruview-presence
```

Add the skill entry:

```json
{
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

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ruviewUrl` | string | `http://localhost:3000` | RuView API base URL |
| `pollIntervalMs` | number | `10000` | Poll interval in milliseconds |
| `confidenceThreshold` | number | `0.3` | Minimum confidence to count as present |
| `debounceCount` | number | `2` | Consecutive empty checks before marking away |
| `enableDigest` | boolean | `true` | Show digest when user returns |
| `enableZoneAwareness` | boolean | `false` | Track which zone the user is in |

## How it works

The plugin hooks into OpenClaw's `before_prompt_build` lifecycle event. On each agent heartbeat:

1. **Polls** `GET /api/v1/pose/current` on RuView
2. **Evaluates** whether any detected person exceeds the confidence threshold
3. **Transitions** the state machine with debounce (avoids false "away" triggers)
4. **On return** — prepends a digest to the agent's context with queued events

The bundled skill (`skills/ruview-presence/`) provides standing orders that agents follow during heartbeat cycles, giving them explicit instructions for presence-aware behavior.

## Gateway RPC methods

The plugin registers two RPC methods on the OpenClaw gateway:

| Method | Description |
|--------|-------------|
| `ruview.presence` | Returns current presence state, zone, away duration, queued event count |
| `ruview.queueEvent` | Queue an event to deliver when user returns |

## RuView endpoints used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/pose/current` | Detect persons and confidence |
| `GET /api/v1/pose/zones/summary` | Zone-level occupancy (optional) |
| `GET /health/live` | Verify RuView is reachable |

## Hardware

RuView works in simulation mode out of the box (no hardware needed). For real presence detection:

| Option | Cost | Accuracy |
|--------|------|----------|
| Any WiFi laptop | $0 | RSSI-only (coarse) |
| ESP32-S3 mesh (3-6 nodes) | ~$54 | Full CSI (precise) |
| Research NIC (Intel 5300) | ~$50-100 | Full CSI with MIMO |

## License

MIT
