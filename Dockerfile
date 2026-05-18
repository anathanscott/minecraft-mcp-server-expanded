FROM node:22-alpine

WORKDIR /app

# Copy everything first so tsconfig.build.json is available
COPY . .

# Install dependencies (skip prepare script to control build order)
RUN npm install --ignore-scripts

# Now build TypeScript explicitly
RUN npm run build

# Create schematics directory so it exists at runtime
RUN mkdir -p /app/schematics

CMD ["node", "dist/main.js"]
