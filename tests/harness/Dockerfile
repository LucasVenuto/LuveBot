FROM node:24-bookworm-slim AS dashboard
WORKDIR /opt/hermes
COPY --from=hermes . .
RUN npm ci --workspace web --include-workspace-root --ignore-scripts
RUN cd web && ../node_modules/.bin/vite build --outDir /opt/dashboard-dist

FROM python:3.14-slim-bookworm
ARG HERMES_COMMIT
LABEL org.opencontainers.image.revision=$HERMES_COMMIT
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HERMES_HOME=/root/.hermes HERMES_WEB_DIST=/opt/dashboard-dist
WORKDIR /opt/hermes
COPY --from=hermes . .
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential && rm -rf /var/lib/apt/lists/*
RUN test -f README.md || touch README.md
RUN python -m pip install --no-cache-dir -e '.[web,pty,mcp]' 'aiohttp==3.14.3' 'pytest==9.1.1' 'playwright==1.62.0'
RUN python -m playwright install --with-deps chromium
COPY --from=dashboard /opt/dashboard-dist /opt/dashboard-dist
ENTRYPOINT ["python", "/harness/entrypoint.py"]
