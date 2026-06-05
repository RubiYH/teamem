import { spawn } from 'node:child_process';
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult
} from './types.js';

export const runProcess: ProcessRunner = async (
  request: ProcessRunRequest
): Promise<ProcessRunResult> =>
  new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    if (request.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          errorCode: 'ETIMEDOUT'
        });
      }, request.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        errorCode: error.code
      });
    });

    child.on('close', (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
