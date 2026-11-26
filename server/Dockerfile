# vancouver-live: a static musl binary on Alpine (a shell for the Tugport console). Build context: server/.
FROM rust:1.100-alpine3.22@sha256:f8ddfd4b265d9a9e7fd7c36821af4a55771aee2ac3894294687a66c709319be9 AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# dependencies first, so code changes rebuild only this crate
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs && cargo build --release --locked && rm -rf src
COPY src src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked && mkdir /data

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
COPY --from=build /src/target/release/vancouver-live /usr/local/bin/vancouver-live
# the volume on /data starts out owned by nobody, so the service never runs as root
COPY --from=build --chown=65534:65534 /data /data
USER 65534:65534
ENV PORT=8080 DATA=/data/live.db
EXPOSE 8080
CMD ["vancouver-live"]
