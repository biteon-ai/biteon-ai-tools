#!/bin/sh
set -eu
HOST="${OLLAMA_HOST:-http://ollama:11434}"
export OLLAMA_HOST="$HOST"
BASE_MODEL="${BASE_MODEL:-qwen2.5-coder:32b-instruct-q4_K_M}"
echo "Waiting for Ollama at $HOST"
i=0
until ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "Ollama did not become ready"
    exit 1
  fi
  sleep 2
done
if ! ollama show "$BASE_MODEL" >/dev/null 2>&1; then
  echo "Pulling $BASE_MODEL"
  ollama pull "$BASE_MODEL"
fi
if ! ollama show qwen:security-audit >/dev/null 2>&1; then
  echo "Creating qwen:security-audit"
  ollama create qwen:security-audit -f /Modelfile
fi
for extra in qwen2.5-coder:7b qwen2.5-coder:14b; do
  if ! ollama show "$extra" >/dev/null 2>&1; then
    echo "Pulling $extra"
    ollama pull "$extra"
  fi
done
echo "Models ready"
ollama list
