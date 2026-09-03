# syntax=docker/dockerfile:1
# Two stages: Node builds the static site, nginx serves it. The result is a small
# image with no Node runtime — the app is 100% client-side (see README).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Optional build-time settings (same names as the GitHub Pages workflow):
#   VITE_MARK_SEED  covert model-identity seed; empty = no secret mark (dev behaviour)
#   VITE_BUILD_ID   provenance string written into exported 3MF metadata
ARG VITE_MARK_SEED=
ARG VITE_BUILD_ID=docker
ENV VITE_MARK_SEED=$VITE_MARK_SEED \
    VITE_BUILD_ID=$VITE_BUILD_ID
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
