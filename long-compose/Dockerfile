FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    tesseract-ocr \
    fonts-dejavu-core \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /app/outputs /app/data
EXPOSE 4000
CMD ["node", "compose.js"]
