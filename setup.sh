#!/usr/bin/env bash
# ============================================================
#  qBruce setup (Linux / macOS)
#  Installs dependencies and launches the desktop app.
# ============================================================
set -e

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js was not found. Install it from https://nodejs.org and run this again."
  echo
  exit 1
fi

echo "Installing dependencies..."
npm install

echo
echo "Starting qBruce..."
npm start
