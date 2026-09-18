FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json tsconfig.json ./
RUN npm install

# Copy source code and assets
COPY . .

# Compile TypeScript
RUN npm run build

# Default environment configuration
ENV NODE_ENV=production
ENV STARPETS_HOST=0.0.0.0
ENV PORT=10000
ENV AUTO_START_WATCH=true
ENV STARPETS_DB=/var/data/starpets.sqlite

VOLUME ["/var/data"]
EXPOSE 10000 8787

CMD ["npm", "run", "serve"]
