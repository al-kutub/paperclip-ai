#!/bin/sh
# Bootstrap runs in background, waits for server health, then bootstraps if needed.
node /usr/local/bin/pc-bootstrap.js &

# Delegate to the original Paperclip entrypoint so user-remapping and any
# setup it does runs correctly, then it execs the CMD.
if [ -f /paperclip/scripts/docker-entrypoint.sh ]; then
    exec /paperclip/scripts/docker-entrypoint.sh "$@"
elif [ -f /app/docker-entrypoint.sh ]; then
    exec /app/docker-entrypoint.sh "$@"
else
    exec "$@"
fi
