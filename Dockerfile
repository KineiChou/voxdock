# Local-build source image; see THIRD_PARTY_NOTICES.md before redistributing binaries.
FROM node:24.21.0-bookworm-slim
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ "ffmpeg=${FFMPEG_VERSION}" \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.17.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm typecheck \
 && mkdir -p /app/provenance \
 && node --version > /app/provenance/node.txt \
 && pnpm --version > /app/provenance/pnpm.txt \
 && ffmpeg -version > /app/provenance/ffmpeg.txt \
 && dpkg-query -W > /app/provenance/debian-packages.txt
ENV NODE_ENV=production
USER node
EXPOSE 8787
ENTRYPOINT ["node", "--import", "tsx", "apps/bridge/src/cli.ts"]
CMD ["serve", "--config", "/config/voxdock.config.json"]
