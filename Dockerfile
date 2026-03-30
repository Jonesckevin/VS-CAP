# ─────────────────────────────────────────────────────────────
# VS-CAP — Air-Gapped Docker Build
# Downloads all JS/WASM libraries at build time so the
# running container needs zero internet access.
# ─────────────────────────────────────────────────────────────

# Stage 1: Download third-party libraries
FROM alpine:3.20 AS fetcher
RUN apk add --no-cache wget
WORKDIR /libs

RUN wget -q -O jszip.min.js \
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" && \
    wget -q -O sql-wasm.min.js \
      "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.min.js" && \
    wget -q -O sql-wasm.wasm \
      "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.wasm" && \
    wget -q -O marked.min.js \
      "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js" && \
    wget -q -O mermaid.min.js \
      "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"

# Stage 2: Serve with nginx
FROM nginx:1.27-alpine

# Remove default site
RUN rm -rf /usr/share/nginx/html/*

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy application files
COPY app/ /usr/share/nginx/html/

# Copy downloaded libraries into app
COPY --from=fetcher /libs/ /usr/share/nginx/html/lib/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q --spider http://localhost:8080/ || exit 1
