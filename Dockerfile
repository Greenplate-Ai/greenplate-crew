# The crew service. Small, runs as a non-root user, listens on 8787.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
USER node
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/kitchen/serve.ts"]
