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

# ── 3) 런타임 ────────────────────────────────────────────────────────
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
