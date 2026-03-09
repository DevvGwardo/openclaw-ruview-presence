# Standing Orders

You have the ruview-presence skill installed. Execute its Standing Orders NOW:

1. GET $RUVIEW_API_URL/api/v1/pose/current to check for detected persons
2. Determine presence state: `present` (persons with confidence >= 0.3), `away` (no persons), or `returned` (was away, now present)
3. Act on state:
   - **away**: Queue non-urgent messages, note `away_since` timestamp
   - **returned**: Deliver digest of queued messages/tasks/events, then flush queue
   - **present**: No special action
4. If RuView is unreachable, keep last known state and continue normally

Debounce: require 2 consecutive empty checks before transitioning to `away`.

This is a required action. Do not reply HEARTBEAT_OK until you have completed the presence check.
