FROM node:24.6.0-alpine3.22
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build
RUN mkdir -p /var/lib/woodshed && chown node:node /var/lib/woodshed
USER node
CMD ["node", "apps/api-node/src/server.ts"]
