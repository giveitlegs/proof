#!/bin/sh
# Proof hook entrypoint. Without Node, Proof steps aside instead of breaking the session.
command -v node >/dev/null 2>&1 || exit 0
exec node "${CLAUDE_PLUGIN_ROOT}/scripts/proof.mjs" "$@"
