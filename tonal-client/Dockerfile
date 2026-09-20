FROM ghcr.io/home-assistant/amd64-base:latest

WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json /app/package.json

RUN npm install --omit=dev

COPY service.mjs /app/service.mjs
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD ["/run.sh"]