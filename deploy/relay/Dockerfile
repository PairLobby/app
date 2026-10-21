# A PairLobby relay for a container platform (ECS, Kubernetes, Fly, a VM with Docker).
#
#   docker build --build-arg PAIRLOBBY_VERSION=<version> -t pairlobby-relay deploy/relay
#
# Settings come from PAIRLOBBY_* variables at run time; see deploy/relay/README.md.
FROM node:22-bookworm-slim

# The published @pairlobby/local-server version to run. Pinned so a rebuild never changes it silently.
ARG PAIRLOBBY_VERSION
RUN test -n "$PAIRLOBBY_VERSION" || { echo 'build with --build-arg PAIRLOBBY_VERSION=<version>' >&2; exit 1; } \
    && npm install --global --omit=dev --no-audit --no-fund "@pairlobby/local-server@${PAIRLOBBY_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data

ENV PAIRLOBBY_HOST=0.0.0.0 \
    PAIRLOBBY_PORT=8790 \
    PAIRLOBBY_DATA_DIR=/data \
    PAIRLOBBY_REQUEST_LOG=writes \
    NODE_NO_WARNINGS=1

USER node
VOLUME /data
EXPOSE 8790

# The relay answers /health before anything else, whatever Host it is sent.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PAIRLOBBY_PORT || 8790) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# On SIGTERM the relay stops taking requests, takes its last backup, then exits.
STOPSIGNAL SIGTERM
CMD ["pairlobby-relay"]
