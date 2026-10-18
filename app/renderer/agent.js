// The Microsoft Agent player for Clippit: plays the character's animations as Agent did — frame
// durations, sounds, probability branches, and each frame's exit path when interrupted.
// (The same engine as the 1177.es XP desktop, without the desktop.)

class Agent {
  constructor(sprite, data, { sound = () => true } = {}) {
    this.sprite = sprite;
    this.data = data;
    this.wantSound = sound;
    this.anim = null;
    this.name = '';
    this.frame = 0;
    this.exiting = false;
    this.queue = [];
    this.done = null;
    this.timer = 0;
    this.stopTimer = 0;
    this.audio = {};
    this.onIdle = () => {};
  }

  has(name) { return !!this.data.animations[name]; }

  play(name, done) {
    if (!this.has(name)) { if (done) done(); return; }
    this.queue.push({ name, done });
    if (this.anim) this.exiting = true;     // the current animation leaves by its exit path
    else this.next();
  }

  // Looping animations (Thinking, Writing, Processing, the idles) run until something stops them.
  playFor(name, ms, done) {
    this.play(name, done);
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => { if (this.name === name && this.anim) this.exiting = true; }, ms);
  }

  stop() { if (this.anim) this.exiting = true; }

  next() {
    const item = this.queue.shift();
    if (!item) { this.rest(); this.onIdle(); return; }
    clearTimeout(this.stopTimer);
    this.anim = this.data.animations[item.name];
    this.name = item.name;
    this.done = item.done || null;
    this.frame = 0;
    this.exiting = false;
    this.step();
  }

  step() {
    const f = this.anim.frames[this.frame];
    this.show(f.tile);
    if (f.sound !== null && f.sound !== undefined && this.wantSound()) this.sound(f.sound);
    this.timer = setTimeout(() => this.advance(), Math.max(f.duration, 10));
  }

  advance() {
    const frames = this.anim.frames, f = frames[this.frame];
    let n = this.frame + 1;
    if (this.exiting) {
      if (f.exit >= 0) n = f.exit;
    } else if (f.branches.length) {
      let r = Math.random() * 100;
      for (const [to, pct] of f.branches) {
        if (r < pct) { n = to; break; }
        r -= pct;
      }
    }
    if (n < 0 || n >= frames.length) {
      const cb = this.done;
      this.anim = this.done = null;
      this.name = '';
      if (cb) cb();
      this.next();
      return;
    }
    this.frame = n;
    this.step();
  }

  show(tile) {
    if (tile === null || tile === undefined) { this.sprite.style.visibility = 'hidden'; return; }
    const d = this.data;
    this.sprite.style.visibility = '';
    this.sprite.style.backgroundPosition = `-${(tile % d.columns) * d.width}px -${Math.floor(tile / d.columns) * d.height}px`;
  }

  rest() { this.show(this.data.animations.RestPose.frames[0].tile); }

  sound(i) {
    let a = this.audio[i];
    if (!a) {
      a = this.audio[i] = new Audio(`../assets/clippy/sound${i}.wav`);
      a.volume = 0.5;
    }
    a.currentTime = 0;
    a.play().catch(() => {});
  }
}
