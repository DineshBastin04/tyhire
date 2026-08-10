FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# Dev server, not a production build — matches the backend service's own --reload dev
# setup. docker-compose bind-mounts the source over this image (see docker-compose.yml),
# so edits on the host reload live instead of requiring an image rebuild.
CMD ["npm", "run", "dev", "--", "-H", "0.0.0.0", "-p", "3000"]
