FROM node:24.6.0-alpine3.22
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build
USER node
CMD ["node", "apps/api-node/src/server.ts"]
