FROM node:21.4-alpine3.18

# add ffmpeg for cyanea-discord
RUN apk add --no-cache ffmpeg
RUN corepack enable pnpm

# build cyanea
RUN mkdir -p /cyanea/build && mkdir /cyanea/build/packages
COPY build.ts package.json tsconfig.json pnpm-lock.yaml pnpm-workspace.yaml /cyanea/build/
COPY packages /cyanea/build/packages/
RUN cd /cyanea/build && \
  pnpm install --frozen-lockfile && \
  pnpm build && \
  cd .. && \
  mv build/dist/* ./ && \
  rm -rf build && \
  pnpm store prune

# add entrypoint
COPY action/entrypoint.sh /cyanea/entrypoint.sh
ENTRYPOINT [ "/cyanea/entrypoint.sh" ]

# branding (tm)
LABEL org.opencontainers.image.source="https://github.com/pbrucla/cyanea"
LABEL org.opencontainers.image.description="ACM Cyber's modular script for syncing unified event information across disparate platforms!"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="v1.5.0"
