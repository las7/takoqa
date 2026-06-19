# takoqa image: Node + Chromium, driven by tsx (no separate build step).
#
# Base image pinned to a specific tag (supply-chain policy). Update deliberately.
FROM node:22.14.0-bookworm-slim

WORKDIR /app

# --- dependencies (own layer for caching) ---
COPY package.json package-lock.json .npmrc ./
# The lockfile (.npmrc min-release-age) enforces a 7-day minimum release age.
# Age is enforced at lockfile-generation time, not install time (npm/cli#9005),
# so the install must override to 0 or it will error.
RUN npm ci --min-release-age=0

# Chromium + its system libraries (the slim base ships none of them).
# Installs the browser build matching the pinned playwright version.
RUN npx playwright install --with-deps chromium

# --- application sources ---
COPY tsconfig.json ./
COPY src ./src
COPY profiles ./profiles

# Set production only AFTER npm ci so dev deps (tsx, typescript) are installed.
ENV NODE_ENV=production

# Args after the entrypoint select the profile/flags, e.g.:
#   docker run --network host -e ANTHROPIC_API_KEY=... takoqa \
#     --profile profiles/example.yaml --tag smoke
ENTRYPOINT ["npx", "tsx", "src/run.ts"]
CMD ["--profile", "profiles/example.yaml"]
