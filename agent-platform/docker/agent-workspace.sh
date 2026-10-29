#!/bin/sh
# Clone the primary repository and each linked repository into the agent workspace.
# Authenticated clones that fail here are retried by the worker with the stored credential.
set -u
cd /app/workspace

clone_repo() {
  url="$1"
  dir="$2"
  if [ -z "$url" ] || [ -d "$dir/.git" ]; then
    return 0
  fi
  mkdir -p "$dir"
  git clone "$url" "$dir" || echo "clone of $dir will be retried by the worker"
}

if [ -n "${PRIMARY_REPO_URL:-}" ]; then
  clone_repo "$PRIMARY_REPO_URL" repo-primary
fi

index=0
for url in ${SECONDARY_REPO_URLS:-}; do
  index=$((index + 1))
  if [ "$index" -eq 1 ]; then
    dir=repo-secondary
  else
    dir="repo-secondary-$index"
  fi
  clone_repo "$url" "$dir"
done

exec node -e "setInterval(()=>{},1<<30)"
