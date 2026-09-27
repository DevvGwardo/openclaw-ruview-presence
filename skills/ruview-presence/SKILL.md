---
name: ruview-presence
description: "Answer questions about whether the user is physically present, which room or zone they're in, or their breathing and heart rate, using RuView WiFi sensing. The ruview-presence plugin already tracks presence automatically; use this skill only when the user asks or when you need fresh sensor data."
metadata: { "openclaw": { "emoji": "📡" } }
---

# RuView Presence

The **ruview-presence plugin** handles presence for you. Before each turn it polls RuView and tracks whether the user is `present` or `away`. It holds non-urgent events while they're away, and when they come back it adds a digest to your context that starts with "Welcome back!".

## What you should do

- **Don't poll RuView on every turn or heartbeat.** The plugin already does that.
- **If a "Welcome back!" digest is in your context,** open your reply with a short, friendly version of it. Mention the queued items, then carry on with what the user asked.
- **Use the commands below only when they're needed:** the user asks about presence, their room, their vitals, or whether sensing is working; or you need current data to answer.

## Querying RuView

```bash
RUVIEW_URL="${RUVIEW_API_URL:-http://localhost:3000}"
# If RuView auth is on, add: -H "Authorization: Bearer $RUVIEW_API_KEY"
```

| Question | Command | Look at |
|:---------|:--------|:--------|
| Is anyone there? | `curl -s "$RUVIEW_URL/api/v1/pose/current"` | `persons[].confidence` (≥ 0.3 counts as present), `persons[].zone`, `source` |
| Which zones are occupied? | `curl -s "$RUVIEW_URL/api/v1/pose/zones/summary"` | `zones.<name>.person_count` |
| Breathing and heart rate | `curl -s "$RUVIEW_URL/api/v1/vital-signs"` | `vital_signs.breathing_rate_bpm`, `heart_rate_bpm` and their `*_confidence` |
| Motion and signal detail | `curl -s "$RUVIEW_URL/api/v1/sensing/latest"` | `classification.motion_level`, `features.mean_rssi` |
| Is RuView up? | `curl -s "$RUVIEW_URL/health/live"` | `{"status":"alive"}` |

Example `pose/current` response:

```json
{
  "timestamp": 1773088911.824,
  "source": "esp32",
  "total_persons": 1,
  "persons": [{ "id": 1, "confidence": 0.78, "zone": "zone_1" }]
}
```

## Things to be honest about

- **`source` is `"simulated"`:** the data is synthetic, so don't tell the user they are or aren't present based on it. Say that RuView is in simulation mode.
- **Low vital-sign confidence (below ~0.5):** present the readings as rough estimates, not measurements.
- **RuView unreachable:** say so briefly and carry on with the user's request. Never block on it.
