# Node.js with Python for yt-dlp
FROM node:20-slim

# Install Python, pip, ffmpeg for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install yt-dlp globally
RUN python3 -m pip install --break-system-packages yt-dlp

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create temp directory for audio files
RUN mkdir -p /app/temp

# Expose port (Railway sets PORT automatically)
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
