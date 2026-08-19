FROM node:20-slim

# System dependencies: ffmpeg + Chromium requirements for Remotion rendering
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fontconfig \
    curl \
    ca-certificates \
    unzip \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Remotion/Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

# Rhubarb Lip Sync CLI, for cartoon-scene mouth-cue generation. Installed as
# a directory rather than a bare binary: the pocketSphinx recognizer it uses
# by default needs its acoustic-model files (res/) alongside the executable
# at runtime, not just the executable itself.
ARG RHUBARB_VERSION=1.14.0
RUN curl -sL "https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${RHUBARB_VERSION}/Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Linux.zip" -o /tmp/rhubarb.zip \
    && unzip -q /tmp/rhubarb.zip -d /opt \
    && mv "/opt/Rhubarb-Lip-Sync-${RHUBARB_VERSION}-Linux" /opt/rhubarb \
    && chmod +x /opt/rhubarb/rhubarb \
    && rm /tmp/rhubarb.zip
ENV PATH="/opt/rhubarb:${PATH}"

WORKDIR /app

# Install main service dependencies
COPY package*.json ./
RUN npm install --production

# Install Remotion project dependencies.
# Remotion's bundler pulls @rspack/core, whose platform-native binding
# (@rspack/binding-linux-x64-gnu) is an OPTIONAL dependency that npm's
# optional-deps bug (npm/cli#4828) can silently skip - causing a runtime
# "Cannot find native binding" that breaks every template/caption render.
# Force-install the Linux binding at the exact version npm resolved for
# @rspack/binding so it always matches.
COPY remotion/package*.json ./remotion/
RUN cd remotion && npm install && \
    RSPACK_VER="$(node -p "require('@rspack/binding/package.json').version")" && \
    echo "Ensuring @rspack/binding-linux-x64-gnu@${RSPACK_VER}" && \
    npm install --no-save "@rspack/binding-linux-x64-gnu@${RSPACK_VER}" && \
    node -e "require('@rspack/binding'); console.log('rspack binding OK')"

# Copy all source
COPY . .

# Install Inter fonts system-wide for both libass and Remotion
RUN mkdir -p /usr/share/fonts/truetype/custom && \
    cp motion-assets/fonts/*.ttf /usr/share/fonts/truetype/custom/ && \
    fc-cache -f

EXPOSE 4000
CMD ["node", "compose.js"]
