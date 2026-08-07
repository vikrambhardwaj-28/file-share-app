FROM node:20-slim

# Install LibreOffice Writer, Calc, Java JRE, and fonts for full conversion support
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-java-common \
    default-jre \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt-get/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --cpu=x64 --os=linux sharp
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]