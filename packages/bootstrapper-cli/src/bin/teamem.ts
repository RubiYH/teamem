#!/usr/bin/env bun

import { runCli } from '../cli.js';

process.exitCode = runCli(process.argv.slice(2));
