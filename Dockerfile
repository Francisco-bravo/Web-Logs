FROM node:22-alpine
RUN apk add --no-cache openssh-client docker-cli
WORKDIR /app
COPY package.json server.mjs ./
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8090/health || exit 1
CMD ["node", "server.mjs"]
