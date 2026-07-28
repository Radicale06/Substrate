# Node 22: NestJS 11 needs >=20, and Prisma 7's driver adapters are tested against it.
#
# No browser is installed here — Chrome lives in the reader service, which keeps this
# image small and stops a browser crash from taking the API down with it.
FROM node:22-slim AS base
WORKDIR /app


# --- dependencies -----------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
RUN npm ci


# --- build ------------------------------------------------------------------------
FROM deps AS build
COPY . .
# `npm run build` runs `prisma generate` first; it must not need a live database, which
# is why prisma.config.ts reads process.env rather than Prisma's env() helper.
RUN npm run build
# Keep the Prisma CLI: `migrate deploy` runs at container start when a database is set.
RUN npm prune --omit=dev


# --- runtime ----------------------------------------------------------------------
FROM base AS runtime

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Screenshot storage, written by the reader service over a shared volume and served
# from here. Mount a volume to keep the images on the host.
RUN mkdir -p /app/local-storage && chmod 777 /app/local-storage

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
