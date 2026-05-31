#!/usr/bin/env node
if (process.env.MCP_ECHO_STDERR) {
  process.stderr.write(process.env.MCP_ECHO_STDERR);
}
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk);
});
process.stdin.on('end', () => {
  process.exit(0);
});
