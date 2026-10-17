# One image, two roles on Nebius AI Cloud Serverless:
#   Endpoint (web app + API):   default CMD
#   Job (nightly fleet run):    --container-command "npx" --args "tsx src/cli.ts fleet"
# The Playwright base image ships Chromium and its system libraries for JS-rendered menus.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    MENUSMITH_LLM=live \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build && rm -rf .env .cache bench/private

EXPOSE 8790
CMD ["npx", "tsx", "src/server/index.ts"]
