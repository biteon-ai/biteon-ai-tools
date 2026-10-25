#!/bin/sh
exec python -m uvicorn app:app --host "${BIND_HOST:-0.0.0.0}" --port "${BIND_PORT:-8787}"
