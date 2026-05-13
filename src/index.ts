import { loadConfig } from './config.js';

export function bootstrap(): {
  status: 'ok';
  config: ReturnType<typeof loadConfig>;
} {
  return {
    status: 'ok',
    config: loadConfig()
  };
}
