FROM rust:1.98-slim AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release --bin VRCStreamer

FROM gcr.io/distroless/cc-debian13 AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/VRCStreamer .
COPY placeholders ./placeholders

EXPOSE 80 443 554

ENV SERVER_NAME="Self-Hosted Instance"
ENV BIND_ADDR="0.0.0.0:80"
ENV TLS_CERT_PATH=none
ENV TLS_KEY_PATH=none
ENV RTSP_BIND_ADDR="0.0.0.0:554"
ENV RUST_LOG="warn"

CMD ["./VRCStreamer"]
