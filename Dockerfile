FROM ghcr.io/paperclipai/paperclip:latest

USER root
COPY pc-bootstrap.js /usr/local/bin/pc-bootstrap.js
COPY pc-entrypoint.sh /usr/local/bin/pc-entrypoint.sh
RUN chmod +x /usr/local/bin/pc-entrypoint.sh

# node is already in PATH from base image
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
# No CMD override — inherits base image CMD (original Paperclip startup)
