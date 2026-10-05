FROM node:20-bookworm-slim
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
ENV NODE_ENV=production PORT=3001 TRUST_PROXY=1
EXPOSE 3001
USER node
CMD ["node", "src/server.js"]
