#!/bin/sh
set -e
# The data volume may be root-owned (created by earlier root-user runs). Fix its
# ownership while we still have root, then drop to the unprivileged 'node' user
# before starting the app.
mkdir -p /app/data/wheels /app/data/images
chown -R node:node /app/data
exec su-exec node "$@"
