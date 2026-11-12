#!/usr/bin/env bash
# End-to-end check of the sample questions against a seeded DB (run `npm run seed -- --demo-change` first).
# Pauses between turns keep the Groq free tier (8k tokens/min) from throttling.
# Usage: DB_PATH=data/minimi.db bash scripts/e2e.sh
set -u
ask() {
  echo
  echo "################################################################"
  echo "Q: $1"
  echo "################################################################"
  npx tsx --no-warnings --env-file-if-exists=.env scripts/ask.ts "$1" 2>&1 | sed -n '/===== FINAL =====/,$p'
  sleep "${PAUSE:-45}"
}
ask "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"
ask "What did I ask you on 3 November? Is your answer still correct today?"
ask "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"
ask "I asked about Gemini's API price on 5 Nov. Did it change?"
ask "What did I ask you on 1 November?"
ask "hi! how are you?"
