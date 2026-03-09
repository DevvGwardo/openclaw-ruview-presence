---
name: ruview-presence
description: "Presence-aware agent behavior powered by RuView WiFi sensing. Polls RuView's pose/presence API to detect whether the user is physically present, away, or just returned. Queues non-urgent messages when away, delivers a digest on return. Activate on every heartbeat."
metadata: { "openclaw": { "emoji": "📡", "requires": { "env": ["RUVIEW_API_URL"] }, "primaryEnv": "RUVIEW_API_URL" } }
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
curl -s "$RUVIEW_URL/api/v1/pose/current" \
  -H "Content-Type: application/json"
```

Response:

```json
{
  "timestamp": 1773088911.824,
  "source": "simulate",
  "total_persons": 1,
  "persons": [
    {
      "id": 1,
      "confidence": 0.75,
      "zone": "zone_1",
      "bbox": { "x": 224.4, "y": 133.4, "width": 128.4, "height": 249.6 },
      "keypoints": [ ... ]
    }
  ]
}
```

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
    "zone_3": { "person_count": 0, "status": "clear" }
  }
}
```

Use zone data to adjust tone or urgency — e.g., if user is in the kitchen, they may be on a short break vs. truly away.

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
| `RUVIEW_CONFIDENCE_THRESHOLD` | `0.3` | Minimum confidence to count as present |
| `RUVIEW_DEBOUNCE_COUNT` | `2` | Consecutive empty checks before marking away |

## Setup

1. Start RuView locally:
   ```bash
   docker run -p 3000:3000 ruvnet/wifi-densepose:latest
   ```

2. Copy skill files to OpenClaw:
   ```bash
   cp -r skills/ruview-presence ~/.openclaw/skills/ruview-presence
   ```

3. Add the skill entry to `~/.openclaw/openclaw.json` (see Configuration above)

4. Verify RuView is reachable:
   ```bash
   curl -s http://localhost:3000/health/live
   ```
