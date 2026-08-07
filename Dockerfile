FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./

# Install sharp with linux-x64 prebuilt binaries
RUN npm install --cpu=x64 --os=linux sharp
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]