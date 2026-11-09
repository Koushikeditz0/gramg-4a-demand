FROM node:20-bookworm-slim
ENV TZ=Asia/Kolkata NODE_ENV=production DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY vbr-core.js iay-sync.js ./
USER node
VOLUME ["/data"]
CMD ["node", "iay-sync.js"]
