/**
 * SandboxDO - Container Durable Object that runs ExecutionAgent.
 *
 * Each SandboxDO instance = one repo + branch combination. It runs a
 * fully independent Linux container with bun + codex + ExecutionAgent
 * listening on port 9999. Since each sandbox is its own container,
 * git worktrees are unnecessary — branches get their own sandbox.
 *
 * The UserDO connects to SandboxDO instances via getSandbox() and proxies
 * execution RPCs over WebSocket.
 *
 * @module SandboxDO
 */
export { Sandbox as SandboxDO } from "@cloudflare/sandbox";
