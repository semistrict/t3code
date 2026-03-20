// Stub for fast-check — not needed at runtime.
// fast-check is pulled in by Effect's Schema module for test data generation
// but uses Math.random at module init which Cloudflare disallows in global scope.
export {};
