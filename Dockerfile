FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY data ./data
COPY scripts ./scripts
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8098
EXPOSE 8098
CMD ["node","server.mjs"]
