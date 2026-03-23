import { RequestType, Channel, Fangs } from './types';

export { RequestType, Channel };

export class BatFangs extends Fangs {
  constructor(opts: { maxConcurrency?: number; channels: Channel[] }) {
    super({ maxConcurrency: opts.maxConcurrency, channels: opts.channels });
  }
}
