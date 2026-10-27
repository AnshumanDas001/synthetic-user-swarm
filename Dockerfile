# Swarm dashboard + CLI. Playwright's image ships Chromium and its system libraries.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
# PORT is injected by the host (Render sets it); 4300 otherwise. Node's heap is capped for small instances.
ENV NODE_ENV=production \
    SWARM_DATA_DIR=/data \
    SWARM_HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=320

COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so dev dependencies are needed at runtime.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY demo-shop ./demo-shop
COPY personas ./personas
COPY studies ./studies
COPY benchmark ./benchmark
COPY bin ./bin

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 4300

# A login is required: the server refuses to listen on 0.0.0.0 without GOOGLE_CLIENT_ID or SWARM_PASSWORD.
CMD ["node", "--import", "tsx", "src/cli.ts", "serve"]
