#!/bin/bash
# Start RSSI Daemon for Hermes RuView Presence
# Builds Swift binary if needed and starts rssi_daemon.py in background

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TOOLS_DIR="$PROJECT_DIR/tools/macos-wifi-scan"
BINARY_PATH="/usr/local/bin/macos-wifi-scan"
DAEMON_SCRIPT="$SCRIPT_DIR/rssi_daemon.py"
PID_DIR="$HOME/.hermes/run"
PID_FILE="$PID_DIR/macos-rssi-daemon.pid"
LOG_DIR="$HOME/.hermes/logs"
LOG_FILE="$LOG_DIR/macos-rssi-daemon.log"

# Create required directories
mkdir -p "$PID_DIR"
mkdir -p "$LOG_DIR"

# Build Swift binary if needed
build_binary() {
    if [ -f "$BINARY_PATH" ] && [ -x "$BINARY_PATH" ]; then
        echo "Binary already exists at $BINARY_PATH"
        return 0
    fi
    
    if [ -d "$TOOLS_DIR" ] && [ -f "$TOOLS_DIR/build.sh" ]; then
        echo "Building macos-wifi-scan..."
        cd "$TOOLS_DIR"
        ./build.sh
        cd - > /dev/null
        
        # Check if build succeeded
        if [ ! -f "$BINARY_PATH" ]; then
            # Try project-local build output
            LOCAL_BINARY="$TOOLS_DIR/.build/Debug/macos-wifi-scan"
            if [ -f "$LOCAL_BINARY" ]; then
                echo "Installing binary to $BINARY_PATH..."
                cp "$LOCAL_BINARY" "$BINARY_PATH"
                chmod +x "$BINARY_PATH"
            else
                echo "Error: Build failed - binary not found at $BINARY_PATH or $LOCAL_BINARY"
                exit 1
            fi
        fi
    else
        echo "Error: Build script not found at $TOOLS_DIR/build.sh"
        echo "Please build manually: cd $TOOLS_DIR && ./build.sh"
        exit 1
    fi
}

# Stop existing daemon if running
stop_existing() {
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Stopping existing daemon (PID $OLD_PID)..."
            kill "$OLD_PID" 2>/dev/null || true
            sleep 1
        fi
        rm -f "$PID_FILE"
    fi
}

# Start the daemon
start_daemon() {
    echo "Starting RSSI daemon..."
    echo "Logging to $LOG_FILE"
    
    # Run daemon in background, redirecting output
    nohup python3 "$DAEMON_SCRIPT" >> "$LOG_FILE" 2>&1 &
    DAEMON_PID=$!
    
    # Save PID
    echo "$DAEMON_PID" > "$PID_FILE"
    
    # Wait a moment and verify it started
    sleep 1
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "RSSI daemon started successfully (PID $DAEMON_PID)"
        echo "PID saved to $PID_FILE"
    else
        echo "Error: Daemon failed to start. Check $LOG_FILE for details."
        rm -f "$PID_FILE"
        exit 1
    fi
}

# Main
echo "=== RSSI Daemon for Hermes RuView Presence ==="

# Build if needed
build_binary

# Stop any existing daemon
stop_existing

# Start new daemon
start_daemon

echo ""
echo "Configuration:"
echo "  Set RUVIEW_API_URL=http://localhost:3002 in your .hermes-ruview-env"
echo "  The daemon serves presence data at http://localhost:3002/api/v1/pose/current"
echo ""
echo "Logs: tail -f $LOG_FILE"
echo "Stop: kill \$(cat $PID_FILE)"