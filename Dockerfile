FROM node:22-bookworm-slim

# ffmpeg enables per-platform reframing/transcoding. Remove this block to build
# a smaller image that forwards source files unchanged.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4000

USER node
CMD ["node", "src/index.js"]
