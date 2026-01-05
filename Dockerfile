# Node.js with Python for yt-dlp
FROM node:20-slim

# Install Python, pip, ffmpeg for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir yt-dlp

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create temp directory for audio files
RUN mkdir -p /app/temp

# Expose port (Railway sets PORT automatically)
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
