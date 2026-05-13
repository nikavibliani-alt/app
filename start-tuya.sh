#!/bin/bash
# start-tuya.sh — start the local Tuya proxy server
# Usage: bash start-tuya.sh  (or chmod +x start-tuya.sh && ./start-tuya.sh)

DIR="$(cd "$(dirname "$0")" && pwd)"

# Check Node.js is available
if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install from https://nodejs.org"
  exit 1
fi

echo "Starting Tuya proxy..."
node "$DIR/tuya-proxy.js"
