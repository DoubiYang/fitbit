FROM node:25-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY health.mjs server.mjs ./
USER node
EXPOSE 3001
CMD ["node", "server.mjs"]
