#!/bin/sh
# Bootstrap runs in the background — it polls until Paperclip is ready,
# then runs the idempotent setup (no-op if DB already bootstrapped).
node /usr/local/bin/pc-bootstrap.js &

# Paperclip is PID 1 (exec'd), so Railway healthchecks work normally.
exec "$@"
