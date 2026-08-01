FROM pca-gha-runner:2.336.0

USER root

# Reuse the proven local arm64 runner and add only what Fusion's CI jobs need:
# a Docker client for the PostgreSQL service container, psql for the harness,
# and the trusted Linux verifier-confinement executable. Installing bubblewrap
# here is necessary but not sufficient: the workflow runs a functional probe
# so an outer container profile that blocks namespaces still fails closed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl docker.io postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Product-route fixtures use Go Task inside campaign-owned worktrees. Pin the
# ARM64 release and verify its upstream SHA-256 before installing the binary;
# never rely on an ambient host package or a remote shell installer.
ARG GO_TASK_VERSION=3.51.1
ARG GO_TASK_LINUX_ARM64_SHA256=49c58bb00eff2449a5553f3b3e694fc424e0dc04d5c669d8831126daee1000f8
RUN curl --fail --silent --show-error --location \
      "https://github.com/go-task/task/releases/download/v${GO_TASK_VERSION}/task_linux_arm64.tar.gz" \
      --output /tmp/task_linux_arm64.tar.gz \
    && echo "${GO_TASK_LINUX_ARM64_SHA256}  /tmp/task_linux_arm64.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/task_linux_arm64.tar.gz -C /usr/local/bin task \
    && rm -f /tmp/task_linux_arm64.tar.gz \
    && task --version

# Docker Desktop's socket is owned by the Mac user. The base runner already
# grants passwordless sudo, so this narrow wrapper lets Actions manage sibling
# service containers without changing host socket permissions.
COPY docker-wrapper.sh /usr/local/bin/docker
RUN chmod 0755 /usr/local/bin/docker

# Pin the restart-safe entrypoint in this derived image instead of inheriting
# whichever bytes happen to own the mutable local base-image tag.
COPY entrypoint.sh /home/runner/entrypoint.sh
RUN chown runner:runner /home/runner/entrypoint.sh \
    && chmod 0755 /home/runner/entrypoint.sh

USER runner
