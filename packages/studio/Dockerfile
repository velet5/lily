# Lily Studio on the web (DECISIONS D55): lily-studio-server with LilyPond and
# bubblewrap, the page built beforehand (`node esbuild.mjs --site --production`
# writes dist/site/ and dist/runtime/). Each user's worker runs in a
# bubblewrap sandbox, which needs user namespaces: run the container with
#
#   docker run -p 8080:8080 -v lily-data:/data \
#     --security-opt seccomp=unconfined --security-opt apparmor=unconfined lily-studio-web
#
# and add an account with
#
#   docker exec -it <container> lily-studio-server user add <name> --data /data
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# A member of the workspace; only its manifest is read.
COPY src-tauri/Cargo.toml src-tauri/Cargo.toml
RUN mkdir -p src-tauri/src && echo 'fn main() {}' > src-tauri/src/main.rs && touch src-tauri/src/lib.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p lily-studio-server \
    && cp target/release/lily-studio-server /lily-studio-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends lilypond bubblewrap fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/lily lily \
    && mkdir /data && chown lily /data
COPY --from=build /lily-studio-server /usr/local/bin/lily-studio-server
COPY dist/site /app/site
COPY dist/runtime /app/runtime
USER lily
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["lily-studio-server"]
CMD ["serve", "--listen", "0.0.0.0:8080", "--data", "/data", "--site", "/app/site", "--runtime", "/app/runtime", "--sandbox", "bwrap"]
