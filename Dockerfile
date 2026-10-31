# Stage 1: Build React frontend
# The frontend build output (HTML, JS, CSS) does not depend on the CPU
# architecture, so build it natively on the build host even when the image is
# built for another platform under emulation.
FROM --platform=$BUILDPLATFORM node:22-slim AS frontend-builder

WORKDIR /build

# .npmrc carries legacy-peer-deps, which the lockfile needs; without it
# npm 10 stops at an ERESOLVE peer conflict.
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci

COPY frontend/src ./src
COPY frontend/index.html ./
COPY frontend/*.config.ts ./
COPY frontend/*.config.cjs ./
COPY frontend/*.json ./

RUN npm run build

# Stage 2: Build Python application
FROM python:3.14-slim

ARG VERSION=unknown
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/dmfdeploy/dmf-cms"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DMF_CONSOLE_APP_CONTRACT_PATH=/app/config/app-contracts.yaml \
    DMF_CONSOLE_BASE_PATH=/

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY config ./config

# Copy built React app into both source tree and installed package location
COPY --from=frontend-builder /src/dmf_cms/static/app ./src/dmf_cms/static/app
RUN pip install --no-cache-dir . && \
    cp -r /app/src/dmf_cms/static/app /usr/local/lib/python3.14/site-packages/dmf_cms/static/app

EXPOSE 8000

CMD ["uvicorn", "dmf_cms.main:app", "--host", "0.0.0.0", "--port", "8000"]
