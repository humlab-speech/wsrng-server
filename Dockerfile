# Multi-stage build for wsrng-server
# This builds the application in a container without requiring Node.js on the host

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM docker.io/library/node:24.22.2-alpine3.24 AS dependencies

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# ============================================================================
# Stage 2: Runtime
# ============================================================================
FROM docker.io/library/node:24.22.2-alpine3.24

# Patch the Alpine packages past the tag's build date, and drop npm and yarn:
# the service runs plain node, and their bundled node_modules are only attack
# surface (and scanner findings).
RUN apk upgrade --no-cache &&     rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx            /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /wsrng-server

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source
COPY package*.json ./
COPY src ./src

# Create the logs directory and hand the app tree to the runtime `node` user
# (uid 1000 / gid 1000). The deployment quadlet pins this uid to the host
# repository owner with rootless --userns=keep-id:uid=1000,gid=1000, so the audio
# wsrng-server writes under /repositories lands owned by that single host identity
# — shared with session-manager, emu-webapp-server and apache. node must own its
# own logs/ because the quadlet drops all capabilities (no DAC_OVERRIDE).
RUN mkdir -p logs && \
    touch logs/wsrng-server.log && \
    chown -R node:node /wsrng-server

USER node
CMD ["node", "src/main.js"]
