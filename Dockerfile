# --- build stage -------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV HOME=/home/node
# Put the google-mcp-* / google-mcp-doctor bins on PATH for `docker compose run`.
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Config/token directory (mount a volume here to persist OAuth tokens).
# Owned by `node` so a fresh named volume mounted here is writable.
RUN mkdir -p /home/node/.google-mcp && chown node:node /home/node/.google-mcp

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
