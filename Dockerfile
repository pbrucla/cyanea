FROM node:21.4-alpine3.18

# add ffmpeg for cyanea-discord
RUN apk add --no-cache ffmpeg

# build cyanea
RUN mkdir build && mkdir build/packages && mkdir build/.yarn
COPY .yarn/plugins build/.yarn/plugins/
COPY .yarnrc.yml build.ts package.json tsconfig.json yarn.lock build/
COPY packages build/packages/
RUN cd build && \
  yarn set version 4.0.2 && \
  yarn workspaces foreach -A install && \
  yarn build && \
  cd .. && \
  mv build/dist/* ./ && \
  rm -rf build

# add entrypoint
COPY action/entrypoint.sh entrypoint.sh
ENTRYPOINT [ "entrypoint.sh" ]
