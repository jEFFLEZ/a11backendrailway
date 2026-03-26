# Use an official lightweight Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Installer dépendances système, copier les fichiers et télécharger Piper en une seule couche
RUN apt-get update \
    && apt-get install -y wget unzip \
    && rm -rf /var/lib/apt/lists/* \
    && wget https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    && tar -xvf piper_linux_x86_64.tar.gz \
    && mv piper /app/piper \
    && chmod +x /app/piper \
    && rm piper_linux_x86_64.tar.gz

# Copier les fichiers de l'app après l'installation système
COPY . /app

# Install Python dependencies if requirements.txt exists
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

# Expose port (change if your app uses a different port)
EXPOSE 5000

# Command to run your TTS server (adjust as needed)
CMD ["python", "serve.py"]
