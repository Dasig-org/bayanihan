#!/bin/sh
# Restore the database from the backup if this machine has none, then run the server under Litestream,
# which streams every change to the replica until the server exits.
set -e
cd /app/packages/server
if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$BIX_DB"
  exec litestream replicate -config /etc/litestream.yml -exec "/app/node_modules/.bin/tsx src/main.ts"
fi
echo "LITESTREAM_REPLICA_URL is not set: running WITHOUT backups."
exec /app/node_modules/.bin/tsx src/main.ts
