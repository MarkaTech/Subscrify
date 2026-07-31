FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Pre-generate the Prisma client at build time so container boot doesn't
# download engines (that cost 30-60s per cold start).
RUN npx prisma generate

RUN npm run build

CMD ["npm", "run", "docker-start"]
