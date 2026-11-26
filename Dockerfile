FROM nginx:1.31-alpine@sha256:7fc0fb4af7bf006aeb31aea88069976060f8f0a0a86b667126742cc17f4e31ae
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
