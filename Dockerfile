# No build stage: the release workflow has already run `npm ci` and `npm run build`
# in the job container, and repeating it here cost ~4.7GB of dind build cache —
# enough to evict the runner off its node. Run `npm run build` before `docker build`.
FROM docker.io/library/busybox:1.36

# main.js + package.json is the pair Headlamp's -plugins-dir expects, named after
# the plugin; dist/fonts/ carries the licenses of the font inlined into main.js.
# World-readable: the consuming initContainer runs as uid 100.
COPY dist/ package.json /plugin/headlamp-agent-sandbox/
RUN chmod -R a+rX /plugin

CMD ["true"]
