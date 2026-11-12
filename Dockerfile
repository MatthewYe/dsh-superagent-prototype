# syntax=docker/dockerfile:1.7

# The product image for one DSH Superagent instance (ticket #2).
#
# One image serves every instance: the profile is baked here and copied into a
# writable DSH home on first start. DSH itself stays on 127.0.0.1:3082 inside the
# container; scripts/docker/relay.mjs publishes it on 0.0.0.0:13082 so compose can
# map a loopback host port onto the relay without a wildcard bind for DSH.

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
ARG IMAGE_TAG=unspecified
# The live host instance keeps its state under this absolute path; the container
# preserves it and backs it with a named volume, so state copied in later (ticket
# #3) needs no path translation.
ARG STATE_DIR=/Users/matthewye/.dsh/state/superagent

LABEL org.opencontainers.image.title="dsh-superagent" \
      org.opencontainers.image.description="One DSH Superagent instance: product, pinned DSH CLI and profile template" \
      org.opencontainers.image.revision="${PRODUCT_COMMIT}" \
      org.opencontainers.image.version="dsh-${DSH_VERSION}" \
      dsh-superagent.image="${IMAGE_TAG}"

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
    && mkdir -p /data/dsh /opt/superagent-template

ENV npm_config_manage_package_manager_versions=false
RUN npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" pnpm@11.7.0

COPY --from=product /opt/dsh-superagent /opt/dsh-superagent
COPY scripts/docker/relay.mjs /usr/local/lib/superagent/relay.mjs
COPY scripts/docker/entrypoint.sh /usr/local/bin/superagent-entrypoint
COPY scripts/docker/healthcheck.sh /usr/local/bin/superagent-healthcheck
RUN chmod 0755 /usr/local/bin/superagent-entrypoint /usr/local/bin/superagent-healthcheck \
    && chmod 0644 /usr/local/lib/superagent/relay.mjs

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
    chown -R 501:20 /opt/superagent-template /opt/dsh-superagent /data/dsh

ENV DSH_HOME=/data/dsh \
    HOME=/data/dsh \
    SUPERAGENT_STATE_DIR=${STATE_DIR} \
    SUPERAGENT_TEMPLATE=/opt/superagent-template \
    SUPERAGENT_RELAY_HOST=0.0.0.0 \
    SUPERAGENT_RELAY_PORT=13082 \
    SUPERAGENT_TARGET_HOST=127.0.0.1 \
    SUPERAGENT_TARGET_PORT=3082

EXPOSE 13082
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/superagent-entrypoint"]
CMD ["dsh", "--profile", "superagent", "--no-open"]
