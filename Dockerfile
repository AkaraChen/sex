# Lightpanda is nightly-only, so it is pinned by digest (multi-arch index of lightpanda/browser:nightly, 1.1.0-nightly.11068+c76c9766a).
# Upgrade deliberately: change the digest here or pass --build-arg LIGHTPANDA_IMAGE=...
ARG LIGHTPANDA_IMAGE=lightpanda/browser@sha256:03dc2a35e6478ad83dd45b31f1efcad50ed1226c312fbff291cb361b72b8ed64
FROM ${LIGHTPANDA_IMAGE} AS lightpanda

FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/sex /usr/local/bin/sex
# Being in the image does not turn the browser on: SEX_LIGHTPANDA / --lightpanda decides.
COPY --from=lightpanda /bin/lightpanda /usr/local/bin/lightpanda
# Lightpanda writes to $HOME/.local/share/lightpanda; the home of nobody (/nonexistent) is not writable.
ENV HOME=/tmp
USER nobody
ENV HOST=0.0.0.0
EXPOSE 3002 3003
ENTRYPOINT ["sex"]
CMD ["http"]
