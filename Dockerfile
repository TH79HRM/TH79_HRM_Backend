# =====================================================
# TH79 HRM Backend - Docker build
# =====================================================

FROM node:20-alpine
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Copy source
COPY src/ ./src/
COPY scripts/ ./scripts/

# Create uploads directory
RUN mkdir -p uploads

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]