# Hosted copy of the planner (Hugging Face Spaces, Docker SDK).
# Builds the web interface, then serves it and the Python engine on port 7860.

FROM node:22-slim AS web
WORKDIR /app/frontend
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM python:3.11-slim
RUN useradd --create-home --uid 1000 user
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ backend/
COPY examples/ examples/
COPY --from=web /app/frontend/dist frontend/dist
USER user
EXPOSE 7860
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
