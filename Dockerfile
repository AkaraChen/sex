FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# One executable with SearXNG (linux-x64 only), Lightpanda (version and SHA-256 pinned in scripts/lightpanda.ts; downloaded
# here) and here-docs with its native engines embedded (see scripts/build.ts).
RUN bun run build

FROM debian:trixie-slim
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
