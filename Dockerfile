# agentsbuzz: feed server, web app and collector in one image (two services in compose).
# Needs Node 22.13+ (built-in node:sqlite without a flag); node:24-slim is current 24.x.
# Pinned by digest so a build always starts from the image that was reviewed; Dependabot proposes updates.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7777 \
    AGENTSBUZZ_DB=/data/buzz.db

WORKDIR /app

# git is needed by the collector to read your projects. safe.directory '*' lets it read repos
# that are owned by a different user on the host (they are mounted read-only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 # The app has no dependencies and never installs anything, so the package managers that ship in
 # the base image (npm, npx, corepack, yarn) are only attack surface and the source of most CVEs.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY package.json ./
COPY server ./server
COPY web ./web
COPY lib ./lib
COPY collector ./collector

# Make the app readable by the unprivileged user whatever the file modes were on the host
# (files copied in with 0600/0700 modes otherwise fail with EACCES), and let it write /data.
RUN chmod -R a+rX /app && mkdir -p /data && chown -R node:node /data
# node is uid/gid 1000 in the base image; numeric so the runtime never has to look the name up
USER 1000:1000
VOLUME /data
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{headers:{authorization:'Bearer '+process.env.AGENTSBUZZ_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The server refuses to listen on 0.0.0.0 without AGENTSBUZZ_TOKEN, so a missing token fails fast.
CMD ["node", "server/server.js"]
