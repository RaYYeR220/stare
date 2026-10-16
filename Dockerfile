# Stare API + MCP server
FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @stare/server... --filter @stare/eval...
# Pin FalkorDB's FLEX UDF library into the image (checksum-verified on load).
RUN node --input-type=module -e "const r=await fetch('https://github.com/FalkorDB/flex/releases/download/1.0.1/flex.js');const fs=await import('node:fs');fs.mkdirSync('/app/.cache',{recursive:true});fs.writeFileSync('/app/.cache/flex-1.0.1.js',await r.text())"
ENV STARE_FLEX_PATH=/app/.cache/flex-1.0.1.js HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
