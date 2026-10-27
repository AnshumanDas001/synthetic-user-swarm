# Swarm dashboard + CLI. Playwright's Python image ships Python 3.12, Chromium and its system libraries.
FROM mcr.microsoft.com/playwright/python:v1.64.1-noble

WORKDIR /app
# PORT is injected by the host (Render sets it); 4300 otherwise.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SWARM_DATA_DIR=/data \
    SWARM_HOST=0.0.0.0

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY swarm ./swarm
COPY demo_shop ./demo_shop
COPY personas ./personas
COPY studies ./studies
COPY benchmark ./benchmark

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]
EXPOSE 4300

# A login is required: the server refuses to listen on 0.0.0.0 without GOOGLE_CLIENT_ID or SWARM_PASSWORD.
CMD ["python", "-m", "swarm", "serve"]
