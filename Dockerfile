# sex (default target) or sex-lite (`docker build --target lite .`).
FROM oven/bun:1.4.3 AS source
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/sex/package.json apps/sex/
COPY apps/sex-lite/package.json apps/sex-lite/
RUN bun install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps

# One executable with SearXNG embedded (linux-x64 only); no browser, LLM or document converter.
FROM source AS build-lite
RUN bun run build:lite

FROM debian:trixie-slim AS lite
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build-lite /app/dist/sex-lite /usr/local/bin/sex-lite
# The embedded SearXNG unpacks to $HOME/.cache/searxng{,-js} on first use; the home of nobody (/nonexistent) is not writable.
ENV HOME=/tmp
USER nobody
ENV HOST=0.0.0.0
EXPOSE 3002
ENTRYPOINT ["sex-lite"]
CMD ["serve"]

# One executable with SearXNG (linux-x64 only), Lightpanda (version and SHA-256 pinned in apps/sex/scripts/lightpanda.ts;
# downloaded here) and here-docs with its native engines embedded (see apps/sex/scripts/build.ts).
FROM source AS build
RUN bun run build

FROM debian:trixie-slim AS sex
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/sex /usr/local/bin/sex
# Being embedded does not turn the browser on: SEX_LIGHTPANDA / --lightpanda decides. Likewise SEX_DOCS for here-docs.
# On first use the embedded SearXNG unpacks to $HOME/.cache/searxng{,-js}, Lightpanda to $HOME/.cache/sex (and writes to
# $HOME/.local/share/lightpanda), and here-docs to $HOME/.cache/sex;
# the home of nobody (/nonexistent) is not writable.
ENV HOME=/tmp
# Jobs (SQLite) live here; compose mounts a volume so they survive container restarts.
RUN mkdir -p /data && chown nobody /data
ENV SEX_DATA_DIR=/data
VOLUME /data
USER nobody
ENV HOST=0.0.0.0
EXPOSE 3002
ENTRYPOINT ["sex"]
CMD ["serve"]
