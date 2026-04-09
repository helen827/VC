FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm run build needs package.json (scripts); without it the step fails in CI/Docker.
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 3417
CMD ["node", "dist/server.js"]
