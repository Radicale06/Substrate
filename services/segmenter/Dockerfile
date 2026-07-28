# Node 22, matching the other TypeScript services.
#
# No browser and no model weights: this is the one capability in the stack that needs
# neither, which is why the image is small and starts instantly.
FROM node:22-slim AS base
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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
