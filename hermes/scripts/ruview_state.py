#!/usr/bin/env python3
"""
Hermes RuView Presence State Machine
Polls RuView pose API and manages presence state transitions.
"""

import json
import os
import time
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional

# Configuration from environment
API_URL = os.environ.get("RUVIEW_API_URL", "http://localhost:3000")
API_KEY = os.environ.get("RUVIEW_API_KEY", None)
CONFIDENCE_THRESHOLD = float(os.environ.get("RUVIEW_CONFIDENCE_THRESHOLD", "0.3"))
DEBOUNCE_COUNT = int(os.environ.get("RUVIEW_DEBOUNCE_COUNT", "2"))

# State file path
STATE_FILE = os.path.expanduser("~/.hermes/memories/hermes-ruview-presence-state.json")

# Ensure directory exists
os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)


def log(message: str) -> None:
    """Print log message with prefix."""
    print(f"[hermes-ruview-presence] {message}")


def load_state(path: str) -> Dict[str, Any]:
    """Load state from JSON file. Returns default state if file doesn't exist."""
    if not os.path.exists(path):
        return {
            "current_state": "present",
            "previous_state": "",
            "away_since": None,
            "empty_check_count": 0,
            "last_poll": 0.0,
            "last_source": None,
            "detected_persons": 0,
            "event_queue": [],
            "pending_digest": False
        }
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        log(f"Error loading state: {e}. Using default state.")
        return {
            "current_state": "present",
            "previous_state": "",
            "away_since": None,
            "empty_check_count": 0,
            "last_poll": 0.0,
            "last_source": None,
            "detected_persons": 0,
            "event_queue": [],
            "pending_digest": False
        }


def save_state(path: str, state: Dict[str, Any]) -> None:
    """Save state to JSON file."""
    try:
        with open(path, "w") as f:
            json.dump(state, f, indent=2)
    except IOError as e:
        log(f"Error saving state: {e}")


def format_duration(ms: float) -> str:
    """Format milliseconds into human readable duration."""
    total_seconds = int(ms / 1000)

    if total_seconds < 60:
        return f"{total_seconds}s"

    minutes = total_seconds // 60
    seconds = total_seconds % 60

    if minutes < 60:
        if seconds == 0:
            return f"{minutes}m"
        return f"{minutes}m {seconds}s"

    hours = minutes // 60
    remaining_minutes = minutes % 60

    if remaining_minutes == 0:
        return f"{hours}h"
    return f"{hours}h {remaining_minutes}m"


def check_presence() -> Dict[str, Any]:
    """
    Call RuView pose API and determine if presence is detected.
    Returns: {detected: bool, persons: int, source: str|null, top_confidence: float|null}
    """
    url = f"{API_URL}/api/v1/pose/current"

    try:
        req = urllib.request.Request(url)
        if API_KEY:
            req.add_header("Authorization", f"Bearer {API_KEY}")

        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))

        persons = data.get("persons", [])
        total_persons = data.get("total_persons", len(persons))
        source = data.get("source", None)

        # Find highest confidence person above threshold
        top_confidence = None
        detected = False

        for person in persons:
            confidence = person.get("confidence", 0.0)
            if confidence >= CONFIDENCE_THRESHOLD:
                detected = True
                if top_confidence is None or confidence > top_confidence:
                    top_confidence = confidence

        return {
            "detected": detected,
            "persons": total_persons,
            "source": source,
            "top_confidence": top_confidence
        }

    except urllib.error.URLError as e:
        log(f"API unreachable: {e}")
        return {
            "detected": None,
            "persons": 0,
            "source": None,
            "top_confidence": None
        }
    except json.JSONDecodeError as e:
        log(f"Invalid API response: {e}")
        return {
            "detected": None,
            "persons": 0,
            "source": None,
            "top_confidence": None
        }
    except Exception as e:
        log(f"Unexpected error checking presence: {e}")
        return {
            "detected": None,
            "persons": 0,
            "source": None,
            "top_confidence": None
        }


def build_digest(state: Dict[str, Any]) -> str:
    """
    Compile event queue into welcome-back message.
    Returns empty string if no events.
    """
    events = state.get("event_queue", [])

    if not events:
        return ""

    away_since = state.get("away_since")
    duration_ms = 0

    if away_since:
        duration_ms = (time.time() - away_since) * 1000

    duration_str = format_duration(duration_ms) if duration_ms > 0 else "unknown"

    lines = [f"Welcome back! You were away for {duration_str}.", "", "While you were away:"]

    # Group events by type and channel
    by_type: Dict[str, int] = {}
    by_channel: Dict[str, int] = {}
    urgent_count = 0

    for event in events:
        t = event.get("type", "message")
        by_type[t] = by_type.get(t, 0) + 1
        ch = event.get("channel")
        if ch:
            by_channel[ch] = by_channel.get(ch, 0) + 1
        if event.get("priority") == "urgent":
            urgent_count += 1

    if by_type.get("message"):
        channels = ", ".join(f"{ch}: {n}" for ch, n in by_channel.items())
        lines.append(f"- {by_type['message']} message(s) queued{channels and ' (' + channels + ')'}")

    if by_type.get("task"):
        lines.append(f"- {by_type['task']} task(s) updated")

    if by_type.get("notification"):
        lines.append(f"- {by_type['notification']} notification(s)")

    if by_type.get("error"):
        lines.append(f"- {by_type['error']} error(s) encountered")

    if urgent_count > 0:
        lines.append(f"- {urgent_count} urgent item(s) were sent immediately")

    lines.append("", "Ready when you are.")
    return "\n".join(lines)


def run_poll() -> Dict[str, Any]:
    """
    Main entry point for a single poll cycle.
    Loads state, checks presence, applies transitions, saves state, returns summary.
    """
    # Load current state
    state = load_state(STATE_FILE)
    previous_state = state.get("current_state", "present")

    # Check presence
    presence = check_presence()
    detected = presence.get("detected")
    persons = presence.get("persons", 0)
    source = presence.get("source")
    top_confidence = presence.get("top_confidence")

    current_time = time.time()

    # Handle unreachable API - preserve last known state
    if detected is None:
        log("RuView unreachable - preserving last known state")
        state["last_poll"] = current_time
        save_state(STATE_FILE, state)
        return {
            "status": "unreachable",
            "current_state": state.get("current_state"),
            "previous_state": previous_state,
            "detected": None,
            "persons": 0
        }

    state["last_poll"] = current_time
    state["last_source"] = source
    state["detected_persons"] = persons

    # State transition logic
    new_state = previous_state

    if previous_state == "present":
        if not detected:
            state["empty_check_count"] = state.get("empty_check_count", 0) + 1
            log(f"No presence detected (count: {state['empty_check_count']}/{DEBOUNCE_COUNT})")

            if state["empty_check_count"] >= DEBOUNCE_COUNT:
                new_state = "away"
                state["away_since"] = current_time
                log("State transition: present -> away")
        else:
            state["empty_check_count"] = 0

    elif previous_state == "away":
        if detected:
            new_state = "returned"
            state["pending_digest"] = True
            log("State transition: away -> returned")

    elif previous_state == "returned":
        if state.get("pending_digest"):
            new_state = "present"
            state["pending_digest"] = False
            state["event_queue"] = []
            away_since = state.get("away_since")
            if away_since:
                dur = format_duration((current_time - away_since) * 1000)
                log(f"State transition: returned -> present (digest delivered, away for {dur})")
            else:
                log("State transition: returned -> present (digest delivered)")
        elif not detected:
            new_state = "away"
            state["away_since"] = current_time
            log("State transition: returned -> away (lost detection)")

    state["previous_state"] = previous_state
    state["current_state"] = new_state

    # Save state
    save_state(STATE_FILE, state)

    # Build summary
    summary = {
        "status": "ok",
        "current_state": new_state,
        "previous_state": previous_state,
        "detected": detected,
        "persons": persons,
        "source": source,
        "confidence": top_confidence,
        "empty_check_count": state.get("empty_check_count", 0),
        "away_duration_ms": None
    }

    if new_state == "returned" and state.get("away_since"):
        summary["away_duration_ms"] = (current_time - state["away_since"]) * 1000
        summary["digest_message"] = build_digest(state)

    log(f"Poll complete: state={new_state}, detected={detected}, persons={persons}")

    return summary


if __name__ == "__main__":
    result = run_poll()
    print(json.dumps(result, indent=2))
