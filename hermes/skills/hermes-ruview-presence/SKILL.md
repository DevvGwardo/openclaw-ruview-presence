---
name: hermes-ruview-presence
description: Presence-aware agent behavior powered by RuView WiFi sensing. Polls RuView's pose/presence API to detect whether the user is physically present, away, or just returned. Queues non-urgent messages when away, delivers a digest on return.
---

# RuView Presence Skill

This skill gives the Hermes agent standing orders for presence-aware behavior based on RuView WiFi CSI sensing.

## Standing Orders

On EVERY conversation start:

1. Read state from `~/.hermes/memories/hermes-ruview-presence-state.json`
2. If `current_state` is `"returned"` AND `pending_digest` is `true`: deliver the digest as your first message, then set `pending_digest: false` and `current_state: "present"` and save
3. If `current_state` is `"away"`: queue mode - hold non-urgent outbound messages in the event queue (append to the `event_queue` list in the state file), save after each addition
4. If RuView is unreachable when you need to check: use the last known state from the state file, do not change state

## State Machine Reference

| State | Meaning | Action |
|---|---|---|
| present | User is in the room | Normal operation |
| away | User left (debounce triggered) | Queue non-urgent messages |
| returned | User just came back | Deliver digest of queued events |

## Presence Check

```bash
curl -s "${RUVIEW_API_URL:-http://localhost:3000}/api/v1/pose/current"
```

Response: `{timestamp, source, total_persons, persons: [{id, confidence, zone}]}`

- `source: "simulate"` = synthetic data
- `source: "csi"` = real hardware

## Queueing Events

When in `away` state, append to `event_queue` in the state JSON:

```json
{"type": "message", "summary": "...", "channel": "discord", "priority": "normal", "timestamp": 1234567890.0}
```

## Digest Format

Deliver on return:

```
Welcome back! You were away for {duration}.

While you were away:
- {N} message(s) queued ({channels})
- {N} task(s) updated
- {urgent_count} urgent item(s) sent immediately

Ready when you are.
```

## Configuration

Set env vars or create `~/.hermes/memories/.ruview-env` with:

```
RUVIEW_API_URL=http://localhost:3000
RUVIEW_API_KEY=
RUVIEW_CONFIDENCE_THRESHOLD=0.3
RUVIEW_DEBOUNCE_COUNT=2
```
