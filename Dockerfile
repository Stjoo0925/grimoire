# Grimoire 웹앱 (compose profile "app")
# Next.js standalone 출력을 쓰는 3단계 빌드 — 최종 이미지에는 런타임 파일만 남는다.

# ── 1) 의존성 ────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── 2) 빌드 ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 빌드 타임에는 실제 시크릿이 필요 없다 (Auth.js는 런타임 env를 읽는다).
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── 3) MCP 서버 빌드 (dist-mcp) ──────────────────────────────────────
# Next/React는 전혀 건드리지 않는다 — tsconfig.mcp.json이 src/mcp + src/lib만 컴파일한다.
FROM node:22-alpine AS mcp-builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run mcp:build

# ── 3-1) MCP 서버 런타임 (docker build --target mcp) ──────────────────
# stdio 기본. MCP_TRANSPORT=http 로 띄우면 8765에서 Streamable HTTP를 받는다(토큰 필수).
# 데이터는 cwd(/app) 기준으로 찾으므로 ./data 를 /app/data 에 마운트하면 된다.
FROM node:22-alpine AS mcp
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=stdio
ENV MCP_PORT=8765
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=mcp-builder /app/dist-mcp ./dist-mcp
# 볼륨을 마운트하지 않아도 경로는 존재하게 (마운트하면 그 위에 덮인다)
RUN mkdir -p /app/data/graph
EXPOSE 8765
ENTRYPOINT ["node", "dist-mcp/mcp/server.js"]

# ── 4) 웹 런타임 (기본 타깃 — 반드시 마지막 스테이지로 둘 것) ─────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 수집 스냅샷·그래프가 쌓이는 곳 (compose에서 ./data를 마운트한다)
RUN mkdir -p /app/data/graph && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
