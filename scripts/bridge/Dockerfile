# Container image for the platform bridge (any always-on container host).
# Build from the repository root:  docker build -f scripts/bridge/Dockerfile -t homecoreos-bridge .
# Run:  docker run -d --restart=always --env-file /etc/homecoreos/bridge.env homecoreos-bridge
FROM node:20-alpine
WORKDIR /app
COPY scripts/bridge/package.json scripts/bridge/package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/bridge/platform_bridge.mjs scripts/bridge/verify_bridge.mjs ./
USER node
CMD ["node", "platform_bridge.mjs"]
