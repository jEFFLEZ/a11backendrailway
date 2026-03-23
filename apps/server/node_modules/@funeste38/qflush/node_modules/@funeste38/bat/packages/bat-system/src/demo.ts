import { Bat, BatEars, BatWings, BatFangs, BatInversion, BatHeart, BatMemory, BatHormones, BatImmune, BatSleep, Channel } from './index';

async function main() {
  const bat = new Bat();
  const ears = new BatEars();
  const wings = new BatWings();
  const inversion = new BatInversion();

  const heart = new BatHeart(500);
  const memory = new BatMemory(20);
  const hormones = new BatHormones();
  const immune = new BatImmune();
  const sleep = new BatSleep();

  heart.onTick(() => {
    // periodic maintenance
    immune.prune();
    // decay hormones applied internally
  });
  heart.start();

  const channels: Channel[] = [
    { id: 'local', kind: 'local', endpoint: 'http://127.0.0.1:3000', weight: 2, stats: { rttAvg: 300, errors: 0, inFlight: 0 } },
    { id: 'tunnel', kind: 'proxy', endpoint: 'https://api.funesterie.me', weight: 1, stats: { rttAvg: 800, errors: 0, inFlight: 0 } }
  ];

  const fangs = new BatFangs({ maxConcurrency: 4, channels });

  // main loop
  for (let i = 0; i < 30; i++) {
    if (inversion.enabled) {
      console.log('UPSIDE DOWN mode active:', inversion.reason);
      await sleep.sleep(500);
      continue;
    }

    const id = bat.start('demo');
    const fake = Math.random() > 0.15 ? 'hello' : '';
    const echo = bat.stop(id)!;
    const earsRes = ears.evaluate(fake, echo.rtt, undefined);

    // push to memory
    memory.push({ time: Date.now(), id, cls: echo.cls, rtt: echo.rtt, signal: earsRes.signalStrength, origin: earsRes.origin });

    // hormones update based on noise/errors
    if (earsRes.isNoise) {
      hormones.inc(5);
    } else {
      hormones.dec(1);
    }

    // immune: blacklist a channel if stress too high
    if (hormones.stress > 80) {
      immune.blacklistChannel('tunnel', 20000);
    }

    // wings apply
    wings.applyProfile(echo.cls);
    if (wings.shouldAbort()) {
      inversion.trigger('too_many_timeouts');
    }

    console.log(i, { echo, ears: earsRes, rate: wings.state.rate, stress: hormones.stress, mem: memory.last(3), immune: immune.list() });

    // small pause
    await new Promise((r) => setTimeout(r, Math.max(10, Math.round(200 / wings.state.rate))));
  }

  heart.stop();
}

main().catch(e => console.error(e));
