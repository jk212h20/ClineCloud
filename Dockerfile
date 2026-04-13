FROM node:20-slim

# Install git (needed for cloning repos at runtime)
RUN apt-get update && apt-get install -y git openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci

# Install Cline CLI globally
RUN npm install -g cline@2.14.0

# Copy app code
COPY . .

# Create data directory
RUN mkdir -p /data/repos

EXPOSE 3000

CMD ["node", "server.js"]
