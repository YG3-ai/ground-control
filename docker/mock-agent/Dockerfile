# Minimal non-root image for the mock agent and isolation probes.
# Real Cursor/Kimi Linux CLIs will be layered in a later image.
FROM alpine:3.20

RUN addgroup -g 1000 agent \
  && adduser -D -u 1000 -G agent -h /home/agent -s /bin/sh agent \
  && mkdir -p /work /tmp \
  && chown -R agent:agent /work

USER agent:agent
WORKDIR /work

# Default command is overridden by the worker.
CMD ["sh", "-c", "echo mock-agent-image-ready"]
