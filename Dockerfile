FROM node:21.4-alpine3.18

# add ffmpeg for cyanea-discord
RUN apk add --no-cache ffmpeg

# build cyanea
RUN mkdir -p /cyanea/build && mkdir /cyanea/build/packages && mkdir /cyanea/build/.yarn
COPY .yarn/plugins /cyanea/build/.yarn/plugins/
COPY .yarnrc.yml build.ts package.json tsconfig.json yarn.lock /cyanea/build/
COPY packages /cyanea/build/packages/
RUN cd /cyanea/build && \
  yarn set version 4.0.2 && \
  yarn install && \
  yarn build && \
  cd .. && \
  mv build/dist/* ./ && \
  rm -rf build

# add entrypoint
COPY action/entrypoint.sh /cyanea/entrypoint.sh
ENTRYPOINT [ "/cyanea/entrypoint.sh" ]

# branding (tm)
LABEL org.opencontainers.image.source https://github.com/pbrucla/cyanea
LABEL org.opencontainers.image.description "ACM Cyber's modular script for syncing unified event information across disparate platforms!"
LABEL org.opencontainers.image.licenses MIT
