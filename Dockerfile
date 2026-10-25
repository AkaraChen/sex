FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/sex /usr/local/bin/sex
USER nobody
ENV HOST=0.0.0.0
EXPOSE 3002 3003
ENTRYPOINT ["sex"]
CMD ["http"]
