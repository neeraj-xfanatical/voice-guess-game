FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install only production dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Run as the non-root "node" user that ships with the image
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "server/index.js"]
