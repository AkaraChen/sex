# Lightpanda is nightly-only, so it is pinned by digest (multi-arch index of lightpanda/browser:nightly, 1.1.0-nightly.11068+c76c9766a).
# Upgrade deliberately: change the digest here or pass --build-arg LIGHTPANDA_IMAGE=...
ARG LIGHTPANDA_IMAGE=lightpanda/browser@sha256:03dc2a35e6478ad83dd45b31f1efcad50ed1226c312fbff291cb361b72b8ed64
FROM ${LIGHTPANDA_IMAGE} AS lightpanda

FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# sex runs from source under bun rather than as the `bun build --compile` binary: a compiled binary cannot load
# here-docs' native engines (SEX_DOCS) from node_modules.
FROM oven/bun:1.4.3-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Being in the image does not turn the browser on: SEX_LIGHTPANDA / --lightpanda decides. Likewise SEX_DOCS for here-docs.
COPY --from=lightpanda /bin/lightpanda /usr/local/bin/lightpanda
# Lightpanda writes to $HOME/.local/share/lightpanda; the home of nobody (/nonexistent) is not writable.
ENV HOME=/tmp
USER nobody
ENV HOST=0.0.0.0
EXPOSE 3002
ENTRYPOINT ["bun", "/app/src/cli.ts"]
CMD ["serve"]
