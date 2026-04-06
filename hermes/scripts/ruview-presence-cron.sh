#!/bin/bash
#
# Hermes RuView Presence Cron Wrapper
# Runs the presence state machine and logs output.
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="${SCRIPT_DIR}/ruview_state.py"
LOG_DIR="${HOME}/.hermes/cron"
LOG_FILE="${LOG_DIR}/ruview-presence.log"
ENV_FILE="${HOME}/.hermes/memories/.ruview-env"

# Ensure log directory exists
mkdir -p "${LOG_DIR}"

# Load environment variables if file exists
if [ -f "${ENV_FILE}" ]; then
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        if [[ -z "$key" || "$key" =~ ^# ]]; then
            continue
        fi
        export "$key=$value"
    done < "${ENV_FILE}"
fi

# Run the Python script, capturing output
OUTPUT=$(python3 "${PYTHON_SCRIPT}" 2>&1)
EXIT_CODE=$?

# Log the output with timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[${TIMESTAMP}] ${OUTPUT}" >> "${LOG_FILE}"

# Also output to stdout so cron emails get the result
echo "${OUTPUT}"

# Exit with the script's exit code
exit ${EXIT_CODE}
