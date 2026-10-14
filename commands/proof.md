---
description: Show whether this session's code changes are verified. `/proof off` or `/proof on` toggles Proof for this project.
argument-hint: "[on|off]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/proof.mjs" --data="${CLAUDE_PLUGIN_DATA}" $ARGUMENTS || true`

Relay the Proof output above to the user exactly as printed, in a code block, with no commentary.
If it says files are unverified and a check is listed, offer to run that check.
