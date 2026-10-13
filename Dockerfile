FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# Zip the Windows client so /client.zip always matches the repo.
COPY client/enter-client.ps1 client/start.bat ./client/
RUN apk add --no-cache zip && zip -qrX public/client.zip client && rm -rf client
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
