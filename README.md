<p align="center">
  <img src="docs/hero-banner.png" alt="RuView Presence Banner" width="95%">
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/Presence%20Plugin-v0.1.0-8b5cf6?style=flat-square&labelColor=0a0a1a" alt="Version"></a>
  <a href="#"><img src="https://img.shields.io/badge/WiFi%20Sensing-CSI%20Based-22d3ee?style=flat-square&labelColor=0a0a1a" alt="WiFi Sensing"></a>
  <a href="#"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square&labelColor=0a0a1a" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/OpenClaw-Plugin-3b82f6?style=flat-square&labelColor=0a0a1a" alt="OpenClaw Plugin"></a>
</p>

# RuView Presence

**Presence-aware AI agents powered by WiFi sensing.** No cameras. No wearables. Just physics.

Your agents detect whether you're physically present using WiFi Channel State Information (CSI). When you leave, they queue non-urgent messages. When you return, they greet you with a digest of everything that happened while you were away.

---

## How It Works

<p align="center">
  <img src="docs/architecture.png" alt="System Architecture" width="95%">
</p>

| State | What Happens |
|:------|:-------------|
| **Present** | Agents operate normally |
| **Away** | Non-urgent messages are queued; urgent ones sent immediately |
| **Returned** | Agents deliver a welcome-back digest, then resume normal operation |

<p align="center">
  <img src="docs/statemachine.png" alt="State Machine" width="80%">
</p>

---

## Quick Start

### 1. Start RuView

```bash
# Simulation (no hardware, synthetic data tagged "simulated")
docker run -d -p 3000:3000 --name ruview \
  -e RUVIEW_ALLOW_UNAUTHENTICATED=1 \
  ruvnet/wifi-densepose:latest

# Live CSI (with ESP32 nodes — exposes UDP 5005 for ADR-018 frames)
docker run -d -p 3000:3000 -p 5005:5005/udp --name ruview \
  -e RUVIEW_ALLOW_UNAUTHENTICATED=1 \
  -e RUVIEW_UDP_BIND=0.0.0.0 -e RUVIEW_UDP_INSECURE_LAN=true \
  ruvnet/wifi-densepose:latest
```

Verify it's running:

```bash
curl -s http://localhost:3000/health/live
# {"status":"alive","uptime":4}
curl -s http://localhost:3000/api/v1/pose/current | jq .source
# "simulated" (no hardware) or "esp32"/"csi" (live)
```

> Works in simulation mode out of the box — no WiFi hardware needed for testing. The `source` field shows `"simulated"` (synthetic) vs `"esp32"`/`"csi"`/`"wifi"` (real hardware). See [Hardware Options](#hardware-options) for live setup. On macOS the local WiFi chip does not expose per-subcarrier CSI — use the included `scripts/live-rssi-bridge.py` for a live RSSI-anchored demo without ESP32 hardware.

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

That's it. Your agents will start checking presence on their next heartbeat. You'll see this in the logs:

```
config change detected; evaluating reload (skills)
config change applied (dynamic reads: skills)
```

---

### Configuration Reference

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `ruviewUrl` | `string` | `http://localhost:3000` | RuView API base URL (trailing slash is auto-trimmed) |
| `apiKey` | `string` | _(none)_ | Bearer token if RuView auth is enabled (env `RUVIEW_API_KEY`) |
| `pollIntervalMs` | `number` | `10000` | How often to poll RuView (ms, min 1000) |
| `confidenceThreshold` | `number` | `0.3` | Minimum detection confidence to count as "present" (0-1) |
| `debounceCount` | `number` | `2` | Consecutive empty readings before marking as "away" |
| `enableDigest` | `boolean` | `true` | Show a summary digest when the user returns |
| `enableZoneAwareness` | `boolean` | `false` | Track which room/zone the user is in |
| `maxQueueSize` | `number` | `100` | Max queued events while away (oldest non-urgent dropped first) |

All options can also be set via environment variables:

| Environment Variable | Maps To |
|:---------------------|:--------|
| `RUVIEW_API_URL` | `ruviewUrl` |
| `RUVIEW_API_KEY` | Auth token (if RuView auth is enabled) |

---

## RuView API Data

These are the actual responses from RuView that the plugin works with.

### Pose Detection (`GET /api/v1/pose/current`)

The primary endpoint used for presence detection.

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

Returns everything above plus raw signal features (mean RSSI, spectral power, motion/breathing band power), per-sensor subcarrier amplitudes, RF tomography voxel grid, and classification.

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

Provides standing orders that agents follow during heartbeat cycles. Gives agents explicit instructions for presence-aware behavior — checking the API, interpreting results, and acting on state changes. Includes the actual JSON response format so agents can parse responses correctly.

### Gateway RPC Methods

The plugin exposes gateway methods for programmatic access:

| Method | Returns |
|:-------|:--------|
| `ruview.presence` | `{ state, zone, awaySince, queuedEvents, detectedPersons, source }` |
| `ruview.diagnostics` | `{ state, zone, awaySince, queuedEvents, detectedPersons, source, emptyCheckCount, consecutiveErrors, lastErrorAt, isLive }` |
| `ruview.health` | `{ ok, source, detected, persons, zone }` or `{ ok:false, error }` (live probe, bypasses throttle) |
| `ruview.queueEvent` | `{ queued: true, total: <count> }` |

---

## Hardware Options

RuView runs in simulation mode by default (`source: "simulated"` in responses). For real-world presence detection (`source: "csi"`/`"esp32"`/`"wifi"`):

| Option | Hardware | Cost | Capability |
|:-------|:---------|:-----|:-----------|
| **No hardware** | Any computer | $0 | Simulation mode (synthetic data) |
| **RSSI bridge (dev)** | Any Mac + `scripts/live-rssi-bridge.py` | $0 | Live RSSI-anchored CSI (real signal, synthetic I/Q) — see `scripts/` |
| **Recommended** | 3-6x ESP32-S3 + router | ~$54 | Full CSI: pose, breathing, heartbeat, motion |
| **Research** | Intel 5300 / Atheros AR9580 | ~$50-100 | Full CSI with 3x3 MIMO |

On Apple Silicon the Broadcom WiFi chip does not expose per-subcarrier CSI. The bridge reads `system_profiler` RSSI (-50 dBm) and injects ADR-018 frames to `UDP 5005`, which promotes RuView from `simulated → esp32` with live `mean_rssi`.

---

## Fault Tolerance

- If RuView is unreachable, the plugin **keeps the last known state** and retries on the next heartbeat (errors are counted in `consecutiveErrors`; logged every 10th failure to avoid spam)
- The debounce mechanism prevents false "away" triggers from momentary signal drops (requires 2 consecutive empty readings by default)
- URL trailing slashes are auto-trimmed; `RUVIEW_API_KEY` is sent as `Bearer` when set
- Queue is capped at 100 (oldest non-urgent dropped first) to prevent unbounded memory growth
- Stale data (>30s old timestamp) is still used but can be surfaced via `ruview.diagnostics`
- Urgent messages are always delivered immediately, regardless of presence state
- The `source` field distinguishes `simulated` from `esp32`/`csi`/`wifi` (live hardware)

---

## Troubleshooting

| Problem | Solution |
|:--------|:---------|
| `refusing to start ... RUVIEW_API_TOKEN is unset` | Set `-e RUVIEW_ALLOW_UNAUTHENTICATED=1` (local/trusted net only) or `-e RUVIEW_API_TOKEN=$(openssl rand -hex 32)` and `apiKey` in config |
| `vite` / `docker` fails on `:3000` bind | `RUVIEW_UDP_BIND=0.0.0.0` requires `RUVIEW_UDP_INSECURE_LAN=true` for routable UDP; otherwise keep `127.0.0.1:5005` and don't publish `5005/udp` |
| Agent says "rate limit reached" | Your model provider is rate-limited. Switch with `openclaw models set <model>` |
| Rate limited by RuView (`429`) | Increase `pollIntervalMs` to `15000+` — plugin backs off on consecutive errors |
| Port 3000 already in use | Map to different port: `docker run -d -p 3002:3000 ...` and update `ruviewUrl` |
| Skill not detected | Check `openclaw logs` for `config change detected` — if missing, restart gateway |
| Always shows "present" | In simulation RuView always returns a synthetic person. Use `scripts/live-rssi-bridge.py` or real ESP32 hardware for true absence |
| `source` stays `simulated` | No CSI frames on `UDP 5005` — verify `docker logs ruview` shows `ESP32 CSI detected` and that `-p 5005:5005/udp` is published |

---

## Project Structure

```
openclaw-ruview-presence/
  index.ts                 Plugin entry point (state machine, polling, digest)
  openclaw.plugin.json     Plugin manifest and config schema (defaults + validation)
  package.json             Package definition + scripts (build/test/typecheck)
  tsconfig.json            Strict TypeScript config
  vitest.config.ts         Vitest config
  tests/
    presence.test.ts       Presence logic + fault tolerance tests
  scripts/
    live-rssi-bridge.py    Live RSSI→CSI bridge for macOS (no ESP32 needed)
  docs/
    hero-banner.png        README hero banner
    architecture.png       System architecture diagram
    statemachine.png       State machine diagram
  skills/
    ruview-presence/
      SKILL.md             Agent standing orders with API response formats
      HEARTBEAT.md         Heartbeat trigger
```

## Development

```bash
npm install
npm run typecheck   # strict tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p tsconfig.json → dist/
```

## Requirements

- Node >=18 (fetch, AbortController)
- [OpenClaw](https://openclaw.com) agent runtime (`>=2026.3.1`)
- [RuView](https://github.com/ruvnet/RuView) sensing server (Docker or native)

## License

MIT

---

<p align="center">
  <sub>Built with <a href="https://github.com/ruvnet/RuView">RuView</a> WiFi sensing and <a href="https://openclaw.com">OpenClaw</a> agent runtime.</sub>
</p>
