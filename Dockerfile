# Multi-stage build for wsrng-server
# This builds the application in a container without requiring Node.js on the host

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:20-alpine AS dependencies

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# ============================================================================
# Stage 2: Runtime
# ============================================================================
FROM node:20-alpine

WORKDIR /wsrng-server

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source
COPY package*.json ./
COPY src ./src

# Create logs directory with correct ownership
RUN mkdir -p logs && \
    touch logs/wsrng-server.log && \
    chown -R node:node /wsrng-server

# Run as node user for security
USER node

CMD ["node", "src/main.js"]
