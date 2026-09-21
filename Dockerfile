FROM node:20-bookworm-slim

# System Chromium + fonts. Skips Puppeteer's own 150 MB download.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates dumb-init \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY examples ./examples

# Chromium needs a real user and a writable /tmp for shared memory.
RUN useradd -m app && chown -R app:app /app
USER app

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
