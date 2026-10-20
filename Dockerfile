# syntax=docker/dockerfile:1
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Set default environment variables
ENV NODE_ENV=production \
    PORT=8080

# Copy package manifests first for optimal caching
COPY --chown=node:node package*.json ./

# Install production dependencies
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || npm install --omit=dev; else npm install --omit=dev; fi

# Copy application source code
COPY --chown=node:node src/ ./src/

# Use built-in unprivileged node user
USER node

# Expose application port
EXPOSE 8080

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

# Launch the simulator
CMD ["node", "src/server.js"]
