FROM node:25-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY health.mjs server.mjs oauth.mjs oauth-http.mjs ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3001
CMD ["node", "server.mjs"]
