# syntax=docker/dockerfile:1
#
# review-agent on your own server (spec 0.2.0 §7): this example, built and run with Node.js 22 on
# Debian, as a non-root user, with Claude Code pinned and its native binary checked at build time.
#
# Build from this folder, after replacing the `workspace:*` ranges in package.json with a published
# version and writing package-lock.json once with npm 11 or newer (README.md, "Use it"):
#
#   docker build --tag review-agent-server .

# Debian (glibc), not Alpine: the App runner's only supported platform, and the one Claude Code's
# native binary is measured on here (spec 0.2.0 §9.1).
ARG NODE_IMAGE=node:22-bookworm-slim

# ── build: compile src/ to dist/server.js, then keep only what runs ──────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
# Exactly what the lockfile says. esbuild (under tsup) needs its install script to place its binary;
# the npm that ships with Node 22 runs it.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ── claude: Claude Code at the version the App runner pins, and proof it is the real binary ─────────
FROM ${NODE_IMAGE} AS claude
# The same version packages/app/trigger.config.ts pins (CLAUDE_CODE_VERSION) and CI smoke-tests. The
# reviewer's flags were measured against it; another version may not accept them.
ARG CLAUDE_CODE_VERSION=2.1.258
WORKDIR /opt/claude-code
# The package's install script is what puts the ~215 MB native binary in place of a ~500-byte
# placeholder. npm 12 skips dependency install scripts by default (spec 0.2.0 §9.4), so it is not left
# to npm: installed with scripts off, then run explicitly — the same on every npm version.
# install.cjs exits 0 even when it could not place the binary, so its exit status proves nothing: the
# size test does (the App runner's image makes the same check, packages/app/trigger.config.ts).
RUN npm install --ignore-scripts --no-audit --no-fund --no-save "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && node node_modules/@anthropic-ai/claude-code/install.cjs \
 && ls -l node_modules/@anthropic-ai/claude-code/bin/claude.exe \
 && test "$(wc -c < node_modules/@anthropic-ai/claude-code/bin/claude.exe)" -gt 1048576

# ── the service ───────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}

# tini as PID 1: it forwards `docker stop`'s SIGTERM to Node and reaps any process Claude Code leaves
# behind. ca-certificates for Claude Code's own connection to Anthropic.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A fixed uid, so the App's key file on the host can be owned by exactly this user (README, "The App's
# key"). No login shell.
ARG UID=10001
RUN groupadd --gid "${UID}" review-agent \
 && useradd --uid "${UID}" --gid review-agent --create-home --home-dir /home/review-agent --shell /usr/sbin/nologin review-agent \
 && install --directory --owner review-agent --group review-agent --mode 0700 /var/lib/review-agent /var/lib/review-agent/claude

# Owned by root and not writable by the service user: nothing the service runs — Claude Code's own
# updater included — can replace the pinned binary.
COPY --from=claude /opt/claude-code /opt/claude-code

ENV NODE_ENV=production HOME=/home/review-agent PORT=8080
# Checkouts and the skill cache, each 0700, under one directory the service user owns.
ENV REVIEW_AGENT_DATA_DIR=/var/lib/review-agent
# Absolute, so the reviewer never searches PATH for it (docs/security.md).
ENV REVIEW_AGENT_CLAUDE_BIN=/opt/claude-code/node_modules/.bin/claude
# Where Claude Code keeps its state: the service user's 0700 directory. It reaches the Claude process
# through the reviewer's allow-list (docs/cli.md, "Environment variables").
ENV CLAUDE_CONFIG_DIR=/var/lib/review-agent/claude
# For any `claude` started in this container by hand. The reviewer starts Claude Code with an
# allow-listed environment that does not carry this variable, so what keeps the reviewer on the pinned
# version is the root-owned install above.
ENV DISABLE_AUTOUPDATER=1

WORKDIR /srv/review-agent
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist

USER review-agent

# Fails the build, not the first review: the binary runs, as the service user, and says its version.
RUN "${REVIEW_AGENT_CLAUDE_BIN}" --version

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
