# The Hub image (docs/ggs-remote-plan.md §20.8): one static binary, one config file, no data
# directory — FROM scratch, nothing to back up. The config mounts at /etc/ggs-hub/hub.toml.
FROM rust:1-alpine AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY web ./web
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release \
    && cp target/release/ggs-remote-hub /ggs-remote-hub

FROM scratch
COPY --from=build /ggs-remote-hub /ggs-remote-hub
ENTRYPOINT ["/ggs-remote-hub", "--config", "/etc/ggs-hub/hub.toml"]
EXPOSE 8443 8080
