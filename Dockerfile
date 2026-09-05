FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js theme-gui.js docker-entrypoint.sh ./
COPY public ./public
RUN mkdir -p /app/clips \
    && chmod +x docker-entrypoint.sh \
    && chown -R node:node /app

USER node
ENTRYPOINT ["./docker-entrypoint.sh"]
