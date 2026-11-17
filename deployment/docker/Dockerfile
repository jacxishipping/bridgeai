FROM python:3.12-slim AS base
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
# The control plane embeds the OAuth gateway on PaaS (combined.py loads
# deployment/oauth/gateway.py relative to the repo root), so it must be in
# the image too — without it the container crashes on boot with
# ModuleNotFoundError: No module named 'gateway'.
COPY deployment/oauth ./deployment/oauth
RUN pip install --no-cache-dir -e .

FROM base AS dev
RUN pip install --no-cache-dir watchfiles
EXPOSE 8000

FROM base AS production
# Render overrides with $PORT at runtime; the app binds 0.0.0.0:$PORT when set.
EXPOSE 8000
CMD ["python", "-m", "ai_bridge.control"]
