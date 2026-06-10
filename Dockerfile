# Stage 1: Build React frontend
FROM node:22-slim as frontend-builder

WORKDIR /build

COPY frontend/package*.json ./
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
