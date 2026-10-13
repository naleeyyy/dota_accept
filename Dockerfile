FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# Served as /client.zip (zipped by server.js at startup).
COPY client/enter-client.ps1 client/start.bat ./client/
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
