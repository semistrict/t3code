FROM docker.io/cloudflare/sandbox:0.7.18

RUN apt-get update && apt-get install -y git build-essential python3 curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
RUN bun install -g @openai/codex@latest

RUN mkdir -p /workspace

# Copy pre-compiled ExecutionAgent binary (built with `bun build --compile`)
COPY dist/t3code-execution-agent /opt/t3code/t3code-execution-agent

EXPOSE 9999
