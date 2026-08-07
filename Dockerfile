FROM node:20-slim

# Install LibreOffice, Poppler (PDF to Image), Python (PDF to DOCX), and Fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt-get/lists/*

# Setup Virtualenv for pdf2docx
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install pdf2docx

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --cpu=x64 --os=linux sharp
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]