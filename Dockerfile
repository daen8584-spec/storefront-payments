FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx, a runtime dependency, runs the TypeScript sources directly.
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/server.ts"]
