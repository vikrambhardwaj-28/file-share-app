FROM node:20-slim

# Install LibreOffice, ImageMagick, and HEIC image libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    imagemagick \
    heif-thumbnailer \
    libheif-examples \
    && rm -rf /var/lib/apt-get/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# Install packages with native linux binaries
RUN npm install --cpu=x64 --os=linux sharp
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]