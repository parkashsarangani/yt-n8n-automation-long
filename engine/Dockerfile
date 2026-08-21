# VidGen engine: agents, execution graph, artifact store, control UI.
#
# TypeScript runs directly via tsx rather than through a build step, so the
# container runs exactly the source in the repo — no compiled artifact that can
# drift from it.
FROM node:22-slim

# curl is for the healthcheck. ffmpeg is intentionally present in the engine as
# well as long-compose: the voice worker uses ElevenLabs' character timestamps
# to trim only leading/trailing TTS padding before audio is stored, keeping
# separately generated dialogue turns tight without silence-detection heuristics.
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not reinstall node_modules.
# devDependencies are needed at runtime: tsx executes the TypeScript.
COPY package*.json ./
RUN npm ci

COPY . .

# Artifacts, blobs, the run log, and the credential file all live here so they
# survive `docker compose down` in a named volume.
ENV AMOS_DATA=/data \
  AMOS_ENV_FILE=/data/.env \
  AMOS_PORT=4321 \
  # Must bind all interfaces to be reachable through a published port. The
  # loopback guarantee comes from the host-side 127.0.0.1 binding in
  # docker-compose.yml plus the Host-header check in src/server.ts.
  AMOS_HOST=0.0.0.0 \
  NODE_ENV=production

RUN mkdir -p /data

EXPOSE 4321

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf -H "Host: localhost" http://127.0.0.1:4321/api/config > /dev/null || exit 1

CMD ["node", "--import", "tsx", "scripts/serve.ts"]
