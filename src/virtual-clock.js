/**
 * Runs inside the page before any user script.
 * Freezes real time and exposes window.__seek(ms) so the renderer can
 * advance the page one frame at a time. This is what makes exports smooth:
 * the browser never has to keep up with real time.
 */
function installVirtualClock(startEpoch) {
  const NativeDate = Date;
  let virtualNow = 0;

  const rafCallbacks = new Map();
  const timers = new Map();
  let nextId = 1;

  // ---- clocks -------------------------------------------------------------
  const nativePerfNow = performance.now.bind(performance);
  performance.now = () => virtualNow;

  class VirtualDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super(startEpoch + virtualNow);
      else super(...args);
    }
    static now() {
      return startEpoch + virtualNow;
    }
  }
  window.Date = VirtualDate;

  // ---- rAF ----------------------------------------------------------------
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    rafCallbacks.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => rafCallbacks.delete(id);

  // ---- timers -------------------------------------------------------------
  const schedule = (fn, delay, args, repeat) => {
    const id = nextId++;
    timers.set(id, {
      fn,
      args,
      due: virtualNow + Math.max(0, delay || 0),
      interval: repeat ? Math.max(1, delay || 1) : null,
    });
    return id;
  };
  window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
  window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
  window.clearTimeout = (id) => timers.delete(id);
  window.clearInterval = (id) => timers.delete(id);

  const runDueTimers = () => {
    // Bounded loop so a setTimeout(fn, 0) chain can't hang the render.
    for (let pass = 0; pass < 100; pass++) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.due <= virtualNow)
        .sort((a, b) => a[1].due - b[1].due);
      if (due.length === 0) return;
      for (const [id, t] of due) {
        if (t.interval === null) timers.delete(id);
        else t.due = virtualNow + t.interval;
        try {
          if (typeof t.fn === 'function') t.fn(...t.args);
          else new Function(t.fn)();
        } catch (e) {
          console.error('[html2video] timer error', e);
        }
      }
    }
  };

  const runRaf = () => {
    const batch = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    for (const [, cb] of batch) {
      try {
        cb(virtualNow);
      } catch (e) {
        console.error('[html2video] rAF error', e);
      }
    }
  };

  // ---- declarative animations & media -------------------------------------
  const syncDeclarative = () => {
    if (document.getAnimations) {
      for (const anim of document.getAnimations()) {
        try {
          anim.pause();
          anim.currentTime = virtualNow;
        } catch (_) {
          /* animation not seekable */
        }
      }
    }
    for (const media of document.querySelectorAll('video, audio')) {
      try {
        media.pause();
        const t = virtualNow / 1000;
        if (Number.isFinite(media.duration) && t <= media.duration) {
          media.currentTime = t;
        }
      } catch (_) {
        /* not ready yet */
      }
    }
  };

  /** Advance the page to an absolute virtual timestamp (ms). */
  window.__seek = (targetMs) => {
    virtualNow = targetMs;
    runDueTimers();
    runRaf();
    syncDeclarative();
    return virtualNow;
  };

  window.__realNow = nativePerfNow;
  window.__virtualClockReady = true;
}

module.exports = { installVirtualClock };
