FROM node:20-slim

# Install LibreOffice, Poppler (pdftoppm, pdftotext), Python3, and Fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt-get/lists/*

# Setup Virtualenv for Python PDF utilities
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install pdf2docx pdfplumber openpyxl

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --cpu=x64 --os=linux sharp
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]