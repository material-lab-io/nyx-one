# OpenClaw Multi-Tenant Container
# Base image with Node.js 22 LTS (required by openclaw)
FROM node:22-slim

LABEL maintainer="nyx-one"
LABEL description="OpenClaw gateway container for multi-tenant deployment"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    curl \
    socat \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to skip downloading Chromium (use system version)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install OpenClaw globally
RUN npm install -g openclaw@2026.2.3

# Create working directory
WORKDIR /root

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default port (can be overridden)
ENV CLAWDBOT_GATEWAY_PORT=18789

# Health check - check the socat forwarded port
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${CLAWDBOT_GATEWAY_PORT}/health || exit 1

# Entry point - run via wrapper that sets up port forwarding
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
