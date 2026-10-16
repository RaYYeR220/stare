#!/bin/sh
# Disposable FalkorDB for the test suite (port 6390).
docker rm -f stare-test >/dev/null 2>&1
docker run -d --name stare-test -p 127.0.0.1:6390:6379 \
  -e FALKORDB_ARGS="THREAD_COUNT 8 TIMEOUT_MAX 30000 TIMEOUT_DEFAULT 10000 MAX_QUEUED_QUERIES 1000 RESULTSET_SIZE 100000" \
  falkordb/falkordb:v4.22.1 >/dev/null
until docker exec stare-test redis-cli PING 2>/dev/null | grep -q PONG; do sleep 0.3; done
echo "falkordb ready on 127.0.0.1:6390"
