FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    tesseract-ocr \
    tesseract-ocr-eng \
    fonts-dejavu-core \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN tesseract --list-langs 2>&1 | grep -qx eng
COPY package*.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /app/outputs /app/data
EXPOSE 4000
CMD ["node", "compose.js"]
