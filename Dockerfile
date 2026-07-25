FROM node:22.21.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22.21.1-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S unlockd && adduser -S unlockd -G unlockd
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
USER unlockd
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server/index.ts"]
