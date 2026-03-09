---
name: ruview-presence
description: "Presence-aware agent behavior powered by RuView WiFi sensing. Polls RuView's pose/presence API to detect whether the user is physically present, away, or just returned. Queues non-urgent messages when away, delivers a digest on return. Activate on every heartbeat."
metadata: { "openclaw": { "emoji": "📡" } }
---

# RuView Presence Awareness

## Standing Orders

On EVERY heartbeat, you MUST complete this sequence:

1. **GET /api/v1/pose/current** — check for detected persons
2. **Determine presence state** from the response (see State Machine below)
3. **Act on state transition** — queue, deliver, or greet (see Actions below)
4. If no state change and presence is `present`, proceed normally with `HEARTBEAT_OK`

This runs BEFORE other skill standing orders. Presence state affects how you handle all downstream work.

## Authentication

Set these variables for all RuView requests:

```bash
RUVIEW_URL="${RUVIEW_API_URL:-http://localhost:3000}"
```

No API key required for local RuView instances. If auth is enabled, add:

```
Authorization: Bearer $RUVIEW_API_KEY
```

## State Machine

You maintain three states. Track `last_state` and `away_since` across heartbeats.

| State | Condition | Meaning |
|-------|-----------|---------|
| `present` | `persons` array has 1+ entries with `confidence >= 0.3` | User is in the room |
| `away` | `persons` array is empty OR all entries have `confidence < 0.3` | User has left |
| `returned` | Previous state was `away`, current check shows `present` | User just came back |

**Transition rules:**
- `present → away` — triggers after **2 consecutive** empty checks (debounce)
- `away → returned` — triggers immediately on first detection
- `returned → present` — automatic after digest is delivered

## Presence Check Workflow

### 1. Poll RuView

```bash
curl -s "$RUVIEW_URL/api/v1/pose/current"
```

Response (actual format from RuView):

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
        { "name": "left_ear", "confidence": 0.72, "x": 320.9, "y": 151.4, "z": -0.22 },
        { "name": "right_ear", "confidence": 0.77, "x": 350.2, "y": 152.0, "z": -0.22 },
        { "name": "left_shoulder", "confidence": 0.77, "x": 311.3, "y": 185.6, "z": -0.22 },
        { "name": "right_shoulder", "confidence": 0.74, "x": 360.6, "y": 186.9, "z": -0.22 },
        { "name": "left_elbow", "confidence": 0.68, "x": 291.4, "y": 206.5, "z": -0.22 },
        { "name": "right_elbow", "confidence": 0.62, "x": 379.8, "y": 228.4, "z": -0.22 },
        { "name": "left_wrist", "confidence": 0.69, "x": 280.4, "y": 234.4, "z": -0.22 },
        { "name": "right_wrist", "confidence": 0.69, "x": 397.0, "y": 269.7, "z": -0.22 },
        { "name": "left_hip", "confidence": 0.66, "x": 321.4, "y": 249.4, "z": -0.22 },
        { "name": "right_hip", "confidence": 0.73, "x": 349.1, "y": 247.9, "z": -0.22 },
        { "name": "left_knee", "confidence": 0.77, "x": 311.3, "y": 316.0, "z": -0.22 },
        { "name": "right_knee", "confidence": 0.77, "x": 358.0, "y": 289.5, "z": -0.22 },
        { "name": "left_ankle", "confidence": 0.69, "x": 324.2, "y": 358.3, "z": -0.22 },
        { "name": "right_ankle", "confidence": 0.69, "x": 351.6, "y": 347.4, "z": -0.22 }
      ]
    }
  ]
}
```

**Key fields for presence detection:**
- `total_persons` — quick check for anyone detected
- `persons[].confidence` — compare against threshold (default 0.3)
- `persons[].zone` — which zone the person is in (e.g. "zone_1")
- `source` — "simulate" means synthetic data, "csi" means real hardware

### 2. Evaluate Presence

```
IF total_persons > 0 AND any person.confidence >= 0.3:
  current = "present"
ELSE:
  current = "away"

IF last_state == "away" AND current == "present":
  current = "returned"
```

### 3. Act on State

#### On `present` → `away` (user left)

- Note the timestamp as `away_since`
- Begin **queuing mode**: hold all non-urgent outbound messages
- For urgent messages (priority: urgent), send normally but note them for the return digest
- Log: `[ruview-presence] User away since {timestamp}`

#### On `away` → `returned` (user came back)

- Calculate `away_duration` from `away_since`
- Compile a digest of everything that happened while away:
  - Messages received (count by channel)
  - Tasks completed or assigned
  - Urgent items that were sent
  - Any errors or blockers encountered
- Deliver the digest as your first message:

```
Welcome back! You were away for {duration}.

While you were away:
- {N} messages queued ({channels})
- {N} tasks updated
- {urgent_count} urgent items sent immediately

Ready when you are.
```

- Flush all queued messages
- Transition to `present`

#### On `present` (steady state)

- No special action. Proceed with normal heartbeat duties.
- Pass `HEARTBEAT_OK` if nothing else needs attention.

## Fallback Behavior

If RuView is unreachable (connection refused, timeout, non-200):

- **Do NOT change presence state** — keep the last known state
- Log: `[ruview-presence] RuView unreachable, keeping state: {last_state}`
- Continue with normal heartbeat — never block on a failed presence check
- Retry on next heartbeat cycle

## Zone-Aware Mode (Optional)

If RuView is configured with multiple zones, you can use zone data for smarter behavior:

```bash
curl -s "$RUVIEW_URL/api/v1/pose/zones/summary"
```

Response:

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

Use zone data to adjust tone or urgency — e.g., if user is in the kitchen, they may be on a short break vs. truly away.

## Additional Endpoints (Optional)

These endpoints are available for richer context but are NOT required for basic presence detection:

### Vital Signs

```bash
curl -s "$RUVIEW_URL/api/v1/vital-signs"
```

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
  "tick": 19612,
  "buffer_status": {
    "breathing_samples": 300,
    "breathing_capacity": 300,
    "heartbeat_samples": 150,
    "heartbeat_capacity": 150
  }
}
```

### Full Sensing Data

```bash
curl -s "$RUVIEW_URL/api/v1/sensing/latest"
```

Returns everything above plus raw signal features (RSSI, spectral power, motion band power), per-node subcarrier amplitudes, RF tomography voxel grid, and classification (`presence: true/false`, `motion_level: "present_still"/"present_moving"/"absent"`).

### Health Check

```bash
curl -s "$RUVIEW_URL/health/live"
```

```json
{ "status": "alive", "uptime": 1961 }
```

## Configuration

Add to `openclaw.json` under `skills.entries`:

```json
{
  "ruview-presence": {
    "enabled": true,
    "env": {
      "RUVIEW_API_URL": "http://localhost:3000"
    }
  }
}
```

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RUVIEW_API_URL` | `http://localhost:3000` | RuView API base URL |
| `RUVIEW_API_KEY` | _(none)_ | API key if RuView auth is enabled |

## Setup

1. Start RuView locally:
   ```bash
   docker run -d -p 3000:3000 --name ruview ruvnet/wifi-densepose:latest
   ```

2. Verify RuView is reachable:
   ```bash
   curl -s http://localhost:3000/health/live
   # Expected: {"status":"alive","uptime":...}
   ```

3. Copy skill files to OpenClaw:
   ```bash
   cp -r skills/ruview-presence ~/.openclaw/skills/ruview-presence
   ```

4. Add the skill entry to `~/.openclaw/openclaw.json` (see Configuration above)

5. Your agents will pick up the skill on their next heartbeat cycle. Check logs for:
   ```
   config change detected; evaluating reload (skills)
   config change applied (dynamic reads: skills)
   ```
