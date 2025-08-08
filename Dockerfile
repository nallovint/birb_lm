# syntax=docker/dockerfile:1
FROM node:20-slim AS base

WORKDIR /app

# Install build deps for native modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

# Optional: copy docs and storage if you want baked-in defaults (compose mounts will override)
COPY docs ./docs
COPY storage ./storage

ENV NODE_ENV=production \
    PORT=3000 \
    TRANSFORMERS_CACHE=/cache

VOLUME ["/cache", "/app/storage", "/app/docs"]

EXPOSE 3000

CMD ["node", "src/server.js"]


