FROM docker.io/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# dist/main.js + package.json is the pair Headlamp's -plugins-dir expects,
# named after the plugin (see `headlamp-plugin extract` in
# @kinvolk/headlamp-plugin/bin/headlamp-plugin.js).
FROM docker.io/library/busybox:1.36 AS plugin
RUN mkdir -p /plugin/headlamp-agent-sandbox
COPY --from=build /app/dist/main.js /app/package.json /plugin/headlamp-agent-sandbox/
RUN chmod -R a+rX /plugin
CMD ["true"]
