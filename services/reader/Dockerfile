# Node 22: NestJS 11 needs >=20, and @supabase/supabase-js needs the native WebSocket
# that landed in 22.
FROM node:22-slim AS base

# Set before any install so puppeteer never downloads its own bundled browser.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
WORKDIR /app


# --- dependencies -----------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
RUN npm ci


# --- build ------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev


# --- runtime ----------------------------------------------------------------------
FROM base AS runtime

# Google Chrome only ships amd64 debs; on other architectures (e.g. arm64) fall back
# to Debian's chromium and symlink it to the path PUPPETEER_EXECUTABLE_PATH expects.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
        && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
        && apt-get update \
        && apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
        apt-get install -y --no-install-recommends chromium \
        && ln -s "$(command -v chromium)" /usr/bin/google-chrome-stable; \
    fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Screenshots land here. The backend serves them, so it mounts the same volume.
RUN mkdir -p /app/local-storage && chmod 777 /app/local-storage

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
