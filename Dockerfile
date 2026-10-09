# The headless edition as a container image (ghcr.io/mempko/abject).
#
#   docker run -d --name abject -v abject-data:/data -p 127.0.0.1:7723:7723 \
#     -e ABJECTS_AUTH_USER=me -e ABJECTS_AUTH_PASSWORD=secret ghcr.io/mempko/abject
#   docker exec -it abject abject setup      # models, permissions
#   docker exec -it abject abject            # chat, inside the container
#   abject --url ws://127.0.0.1:7723         # or from the host, with the login
#
# The image holds the same directory the release archives do (see
# scripts/package-headless.mjs); its `abject` is the whole runtime, so the
# final stage needs no Node. See deploy/README.md.

FROM node:24-bookworm AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN node scripts/package-headless.mjs \
 && mkdir /out \
 && cp -a release/abject-*-linux-*/. /out/

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --create-home abject
COPY --from=build /out /opt/abject
RUN ln -s /opt/abject/abject /usr/local/bin/abject
# The gateway binds every interface inside the container so a published port
# reaches it; publish it on the host's loopback, and set a login.
ENV ABJECTS_DATA_DIR=/data HOME=/data CLI_BIND=0.0.0.0
USER abject
WORKDIR /data
VOLUME /data
EXPOSE 7723
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s CMD ["abject", "status"]
ENTRYPOINT ["/usr/bin/tini", "--", "abject"]
CMD ["serve"]
