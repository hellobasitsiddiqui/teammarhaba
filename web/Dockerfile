# ---- build stage --------------------------------------------------------
# Assembles the static bundle into /dist. Today the sources are plain
# HTML/CSS/JS so the "build" is a copy; this stage is the documented seam
# where a real bundler (Vite/esbuild) drops in later without changing the
# runtime stage.
FROM alpine:3.20 AS build
WORKDIR /src
COPY src/ ./
RUN mkdir -p /dist && cp -r ./. /dist/

# ---- runtime stage ------------------------------------------------------
# Serves the static bundle from nginx.
FROM nginx:1.27-alpine AS runtime

# Replace the default site config with our SPA-aware one.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static assets produced by the build stage.
COPY --from=build /dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -qO- http://localhost:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
