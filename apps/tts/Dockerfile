# Use an official lightweight Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

RUN apt-get update \
    && apt-get install -y wget unzip \
    && rm -rf /var/lib/apt/lists/*

COPY . /app

RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

EXPOSE 5000

RUN chmod +x apps/tts/start.sh

CMD ["bash", "apps/tts/start.sh"]
