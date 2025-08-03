# 1. Use an official Node.js runtime as a parent image
# We use 'bullseye' instead of 'slim' because it contains the tools needed to install dependencies.
FROM node:18-bullseye

# 2. Install system dependencies required by Puppeteer (used by whatsapp-web.js)
# This is the most critical step for running in Docker.
RUN apt-get update && apt-get install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    # <--- ADDED THIS LINE
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Set the working directory in the container
WORKDIR /app

# 4. Copy the package.json and package-lock.json files
COPY package*.json ./

# 5. Install the application's dependencies
RUN npm ci --only=production

# 6. Copy the rest of your application's code to the container
COPY . .

# 7. Command to run the application
# Make sure your main script is named 'wa.js'
CMD ["node", "wa.js"]
