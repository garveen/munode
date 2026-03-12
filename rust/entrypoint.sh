#!/bin/sh
# Fix ownership of writable mount points at runtime, then drop privileges.
# MUNODE_UID / MUNODE_GID control which user the server process runs as and
# who owns files written to the mounted volumes on the host.  They default
# to 1000:1000 and can be set in .env without rebuilding the image.
set -e
RUN_UID="${MUNODE_UID:-1000}"
RUN_GID="${MUNODE_GID:-1000}"
chown -R "${RUN_UID}:${RUN_GID}" /app/logs /app/data
exec su-exec "${RUN_UID}:${RUN_GID}" "$@"
