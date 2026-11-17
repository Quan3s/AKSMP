FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# install chromium + system deps
RUN npx playwright install chromium --with-deps

# chromium headless flags: disable sandbox trong container
ENV PLAYWRIGHT_CHROMIUM_LAUNCH_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# so worker mac dinh khi chay trong container (override bang MAX_WORKERS)
ENV MAX_WORKERS=20

EXPOSE 3000

# dung tini lam init process tranh zombie chromium
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
