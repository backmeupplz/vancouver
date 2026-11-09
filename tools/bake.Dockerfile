# The map bake's toolbox (osmium, uv, Python deps, node for the geometry rules over what the page draws), for running
# tools/bake-all.sh on the server.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool curl rsync ca-certificates && rm -rf /var/lib/apt/lists/*
# node 22 (Debian's 18 can't load the page's ES modules for tools/drawn_check.mjs)
COPY --from=node:22.11.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
ENV UV_LINK_MODE=copy UV_CACHE_DIR=/cache/uv
RUN uv pip install --system numpy scipy pillow shapely rasterio osmium pyproj "laspy[lazrs]"
WORKDIR /w
