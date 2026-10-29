FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker/agent-workspace.sh /usr/local/bin/agent-workspace.sh
RUN chmod 755 /usr/local/bin/agent-workspace.sh
WORKDIR /app/workspace
CMD ["/usr/local/bin/agent-workspace.sh"]
