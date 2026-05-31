#!/usr/bin/env node

const readline = require('node:readline');
const { spawn } = require('@lydell/node-pty');

let pty;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', (line) => {
  if (!line) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'spawn') {
    spawnPty(message.request);
    return;
  }

  if (!pty) {
    return;
  }

  if (message.type === 'write' && typeof message.data === 'string') {
    pty.write(message.data);
    return;
  }

  if (message.type === 'kill') {
    pty.kill(typeof message.signal === 'string' ? message.signal : undefined);
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (pty) {
      pty.kill(signal);
    }
  });
}

function spawnPty(request) {
  if (pty || !request || typeof request !== 'object') {
    return;
  }

  pty = spawn(request.command, Array.isArray(request.args) ? request.args : [], {
    cwd: typeof request.cwd === 'string' ? request.cwd : undefined,
    env: sanitizeEnv(request.env),
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    encoding: 'utf8'
  });
  pty.onData((data) => send({ type: 'data', data }));
  pty.onExit((event) => {
    send({
      type: 'exit',
      exitCode: event.exitCode,
      signal: event.signal
    });
    process.exit(0);
  });
}

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object') {
    return process.env;
  }

  return Object.fromEntries(
    Object.entries(env).filter(
      (entry) => typeof entry[0] === 'string' && typeof entry[1] === 'string'
    )
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
