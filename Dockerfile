FROM node:20-slim

# Install LibreOffice, Python3, and pdf2docx for PDF -> DOCX local conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-java-common \
    default-jre \
    python3 \
    python3-pip \
    python3-venv \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt-get/lists/*

# Setup Python virtualenv for pdf2docx
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