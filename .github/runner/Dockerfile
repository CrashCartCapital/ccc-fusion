FROM pca-gha-runner:2.336.0

USER root

# Reuse the proven local arm64 runner and add only what Fusion's Gate job needs:
# a Docker client for the PostgreSQL service container and psql for the harness.
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker.io postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Docker Desktop's socket is owned by the Mac user. The base runner already
# grants passwordless sudo, so this narrow wrapper lets Actions manage sibling
# service containers without changing host socket permissions.
COPY docker-wrapper.sh /usr/local/bin/docker
RUN chmod 0755 /usr/local/bin/docker

USER runner
