FROM node:20-alpine

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install all dependencies including mineflayer-pvp and prismarine-schematic
RUN npm install

# Copy the full source
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Create schematics directory so it exists at runtime
RUN mkdir -p /app/schematics

# mcpo communicates via stdio, not a network port
CMD ["node", "dist/main.js"]
