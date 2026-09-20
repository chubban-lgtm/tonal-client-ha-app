FROM node:22-alpine

WORKDIR /app

COPY package.json /app/package.json

RUN npm install --omit=dev

COPY service.mjs /app/service.mjs
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD ["/run.sh"]
