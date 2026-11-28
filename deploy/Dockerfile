# Bayanihan Server, with Litestream streaming its SQLite database to S3-compatible storage.
# Build from the repository root, with the sibling bix repository as a named context:
#   docker build -f deploy/Dockerfile --build-context bix=../bix -t bayanihan/server .
# (deploy/compose.yml does this.) The lockfile links @bayanihan/bix to ../bix, so it goes to /bix.
# Build @bayanihan/core first: the server imports its compiled dist/ (since the npm packaging).
FROM node:24-slim AS core
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY --from=bix package.json /bix/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY --from=bix schemas /bix/schemas
RUN ln -s /app/node_modules /bix/node_modules
COPY packages/core packages/core
RUN npm run build -w @bayanihan/core

FROM node:24-slim
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.17
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x86_64) \
 && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz" | tar -xz -C /usr/local/bin litestream \
 && litestream version
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=bix package.json /bix/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=bix schemas /bix/schemas
# bix's own dependencies (ajv) are installed in /app/node_modules; let /bix resolve them from there.
RUN ln -s /app/node_modules /bix/node_modules
COPY packages/core packages/core
COPY --from=core /app/packages/core/dist packages/core/dist
COPY packages/server packages/server
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data /backup && chown node:node /data /backup && chmod +x /usr/local/bin/entrypoint.sh
ENV NODE_ENV=production BIX_DB=/data/bix.db PORT=8787 NODE_NO_WARNINGS=1
USER node
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8787/metadata > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
