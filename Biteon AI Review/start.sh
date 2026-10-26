#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install it with:"
  echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2"
  exit 1
fi
if [ "${FORCE_STACK:-0}" != "1" ]; then
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2)' >/dev/null 2>&1; then
    echo "Ollama is already running on this machine at port 11434."
    echo "Keep using that copy: docker compose -f docker-compose.host.yml up -d --build"
    echo "Use ./start.sh on a VPS that does not already have the model loaded."
    echo "FORCE_STACK=1 ./start.sh starts a second copy anyway."
    exit 1
  fi
fi
avail_kb=$(awk '/MemAvailable/ {print $1}' /proc/meminfo)
if [ "${avail_kb:-0}" -lt 20000000 ]; then
  echo "About 20GB of free RAM is required for qwen2.5-coder 32B."
  echo "Available now: $((avail_kb / 1024)) MB."
  echo "Stop other copies of the model, or set BASE_MODEL to a smaller Ollama model."
  exit 1
fi
docker compose up -d --build
echo
echo "Stack is starting. The first run downloads about 19GB."
echo "UI listens on 127.0.0.1:8787 on this machine only."
echo "On your laptop, run this in a terminal and leave it open:"
echo "  ssh -L 8787:127.0.0.1:8787 root@212.132.71.99"
echo "Then open http://127.0.0.1:8787"
echo "Follow the model download with: docker compose logs -f model-init"
