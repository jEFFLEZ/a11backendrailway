# Use an official lightweight Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies only — Piper binary is downloaded at runtime
RUN apt-get update \
    && apt-get install -y wget tar \
    && rm -rf /var/lib/apt/lists/*

# Copy application files
COPY . /app

# Install Python dependencies if requirements.txt exists
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

# Make the startup script executable
RUN chmod +x /app/startup.sh

# Expose port (change if your app uses a different port)
EXPOSE 5000

# Run the startup script, which downloads Piper if needed then starts the server
CMD ["/app/startup.sh"]
