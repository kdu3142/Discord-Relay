# Use Node.js 20 LTS Alpine for smaller image size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --only=production && npm cache clean --force

# Copy application source
COPY src/ ./src/
COPY webui/ ./webui/
COPY config.env ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# No ports exposed (bot connects outbound only)
# Bot connects to Discord Gateway, no inbound connections needed

# Health check (optional - can be used by orchestrators)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

# Start the application
CMD ["node", "src/index.js"]
