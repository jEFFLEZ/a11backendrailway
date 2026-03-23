export class BatInversion {
  enabled = false;
  reason = '';

  trigger(reason: string) {
    this.enabled = true;
    this.reason = reason;
  }

  reset() { this.enabled = false; this.reason = ''; }
}
