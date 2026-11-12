# syntax=docker/dockerfile:1.7

# The product image for the DSH Superagent instances (tickets #2 and #4).
#
# One image serves every instance: both profile templates are baked here and a
# container copies its own profile into a writable DSH home on first start. The
# two profiles differ only in configuration: the superagent profile binds
# 127.0.0.1:3082 and the livis profile 127.0.0.1:3083 inside the container, and
# scripts/docker/relay.mjs publishes each on 0.0.0.0:13082 / 13083.
#
# The Livis SourceKind plugin is built from its own checkout, supplied as the
# named BuildKit context `livis` (scripts/docker-build passes --build-context):
# its commit is a build input and is recorded in the tag and image label, so a
# plugin change produces a different image instead of a silently vendored copy.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS product
ARG DSH_VERSION=0.2.1-rc.3
ENV npm_config_manage_package_manager_versions=false \
    PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH
RUN npm install --global pnpm@11.7.0
WORKDIR /opt/dsh-superagent
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ARG DSH_VERSION=0.2.1-rc.3
ARG PRODUCT_COMMIT=unknown
ARG LIVIS_COMMIT=unknown
ARG IMAGE_TAG=unspecified
# The live host instances keep their state under these absolute paths; the
# container preserves them and backs each with a named volume, so state copied in
# later (ticket #3) needs no path translation.
ARG STATE_DIR=/Users/matthewye/.dsh/state/superagent
ARG LIVIS_STATE_DIR=/Users/matthewye/.dsh/state/livis

LABEL org.opencontainers.image.title="dsh-superagent" \
      org.opencontainers.image.description="The DSH Superagent instances: product, pinned DSH CLI, Livis source plugin and both profile templates" \
      org.opencontainers.image.revision="${PRODUCT_COMMIT}" \
      org.opencontainers.image.version="dsh-${DSH_VERSION}" \
      dsh-superagent.image="${IMAGE_TAG}" \
      dsh-livis.commit="${LIVIS_COMMIT}"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        gh \
        git \
        git-lfs \
        jq \
        procps \
        python3 \
        socat \
        tini \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# uid 501 / gid 20 is the host operator identity on macOS. GID 20 already exists
# in Debian (dialout), so only the user is added.
RUN useradd --uid 501 --gid 20 --home-dir /data/dsh --no-create-home --shell /bin/bash superagent \
    && mkdir -p /data/dsh /opt/superagent-template /opt/livis-template

# The imported orchestrator state (worker-gitconfig and the GitHub Source's `cli`
# setting) names the host's gh-agent shim by absolute path. Provide the same path
# in the image, with the runtime hosts.yml mounted read-only over its config dir.
RUN mkdir -p /Users/matthewye/.local/bin /Users/matthewye/.config/gh-agent \
    && printf '%s\n' \
        '#!/bin/sh' \
        '# Container-side gh for the imported agent credential; hosts.yml is mounted read-only.' \
        'GH_CONFIG_DIR="${GH_CONFIG_DIR:-/Users/matthewye/.config/gh-agent}"' \
        'export GH_CONFIG_DIR' \
        'exec gh "$@"' \
        > /Users/matthewye/.local/bin/gh-agent \
    && chmod 0755 /Users/matthewye/.local/bin/gh-agent \
    && chown -R 501:20 /Users/matthewye

ENV npm_config_manage_package_manager_versions=false
RUN npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" pnpm@11.7.0

COPY --from=product /opt/dsh-superagent /opt/dsh-superagent
COPY scripts/docker/relay.mjs /usr/local/lib/superagent/relay.mjs
COPY scripts/docker/entrypoint.sh /usr/local/bin/superagent-entrypoint
COPY scripts/docker/healthcheck.sh /usr/local/bin/superagent-healthcheck
RUN chmod 0755 /usr/local/bin/superagent-entrypoint /usr/local/bin/superagent-healthcheck \
    && chmod 0644 /usr/local/lib/superagent/relay.mjs

# Build the Livis SourceKind plugin from its own checkout. Only the workspace
# manifests and the pure-JS sources are copied: the checkout's host
# node_modules must never enter the image or shadow the Linux install.
WORKDIR /opt/dsh-livis
COPY --from=livis package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=livis packages/dsh-livis-protocol/package.json ./packages/dsh-livis-protocol/package.json
COPY --from=livis packages/dsh-livis-protocol/src ./packages/dsh-livis-protocol/src
COPY --from=livis packages/dsh-livis-source/package.json ./packages/dsh-livis-source/package.json
COPY --from=livis packages/dsh-livis-source/index.js ./packages/dsh-livis-source/index.js
COPY --from=livis packages/dsh-livis-source/src ./packages/dsh-livis-source/src
RUN pnpm install --frozen-lockfile

# Bake the `superagent` profile from the Web default profile, then point its
# plugin link at the in-image product. The link `dsh plugin add` writes is
# relative to the template's depth; the home is copied to /data/dsh, so it is
# replaced with an absolute link here.
RUN set -eux; \
    DSH_HOME=/opt/superagent-template dsh --profile superagent --from-default-profile web --dump-config > /dev/null; \
    printf '%s\n' \
      '# Profile configuration for the superagent service (baked into the image).' \
      '- id: webserver' \
      '  config:' \
      '    host: 127.0.0.1' \
      '    port: 3082' \
      '- id: dsh-superagent' \
      '  config:' \
      '    stateDir: /Users/matthewye/.dsh/state/superagent' \
      '# Feishu is optional: uncomment to enable its Source, then set the bot'"'"'s lark-cli on the Feishu Source.' \
      '# - id: dsh-superagent-feishu' \
      '#   disabled: false' \
      > /opt/superagent-template/profiles/superagent/cordis.patch.yml; \
    DSH_HOME=/opt/superagent-template dsh plugin --profile superagent add "link:/opt/dsh-superagent"; \
    ln -sfn /opt/dsh-superagent /opt/superagent-template/profiles/superagent/node_modules/dsh-superagent; \
    chown -R 501:20 /opt/superagent-template /opt/dsh-superagent

# Bake the `livis` profile with its own loopback port, its own absolute state
# directory and the account-routed model. `DSH_LIVIS_STATE_DIR` is a runtime
# override for the container's volume; the plugin default follows HOME and would
# point at /data/dsh instead.
RUN set -eux; \
    DSH_HOME=/opt/livis-template dsh --profile livis --from-default-profile web --dump-config > /dev/null; \
    printf '%s\n' \
      '# Profile configuration for the livis service (baked into the image).' \
      '- id: webserver' \
      '  config:' \
      '    host: 127.0.0.1' \
      '    port: 3083' \
      '- id: dsh-superagent' \
      '  config:' \
      '    stateDir: /Users/matthewye/.dsh/state/livis' \
      '- id: agent-default-model' \
      '  config:' \
      '    provider: deepseek-account' \
      '    model: deepseek-flash' \
      '- insert:' \
      '    - id: dsh-livis-source' \
      '      name: dsh-livis-source' \
      > /opt/livis-template/profiles/livis/cordis.patch.yml; \
    DSH_HOME=/opt/livis-template dsh plugin --profile livis add "link:/opt/dsh-superagent"; \
    DSH_HOME=/opt/livis-template dsh plugin --profile livis add "link:/opt/dsh-livis/packages/dsh-livis-source"; \
    ln -sfn /opt/dsh-superagent /opt/livis-template/profiles/livis/node_modules/dsh-superagent; \
    ln -sfn /opt/dsh-livis/packages/dsh-livis-source /opt/livis-template/profiles/livis/node_modules/dsh-livis-source; \
    chown -R 501:20 /opt/livis-template /opt/dsh-livis /opt/superagent-template /opt/dsh-superagent /data/dsh

ENV DSH_HOME=/data/dsh \
    HOME=/data/dsh \
    PATH=/Users/matthewye/.local/bin:$PATH \
    SUPERAGENT_STATE_DIR=${STATE_DIR} \
    SUPERAGENT_TEMPLATE=/opt/superagent-template \
    SUPERAGENT_CREDENTIALS_SOURCE=/run/superagent/credentials.yaml \
    SUPERAGENT_RELAY_HOST=0.0.0.0 \
    SUPERAGENT_RELAY_PORT=13082 \
    SUPERAGENT_TARGET_HOST=127.0.0.1 \
    SUPERAGENT_TARGET_PORT=3082

EXPOSE 13082
# No CMD: the entrypoint starts `dsh --profile "$DSH_PROFILE" --no-open` when no
# argument is given, so the same image boots whichever service runs it.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/superagent-entrypoint"]
