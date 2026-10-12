# opt2 status page (C56 D7). Build context: repository root.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY ops/status/server.ts ops/status/targets.json ./
USER node
ENV PORT=8080
CMD ["node", "server.ts"]
