FROM node:20-bookworm-slim
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3001 DB_FILE=/data/aurevia.db TRUST_PROXY=1
VOLUME /data
EXPOSE 3001
USER node
CMD ["node", "src/server.js"]
