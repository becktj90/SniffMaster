// Animated header kitten: schedules the occasional tongue-lick.
//
// Everything else (blink, glance, breathing, head bob, ear twitch, sniff)
// is pure CSS on fixed cycles. The lick is the one behavior that should
// feel alive rather than looped, so a tiny scheduler toggles the `.licking`
// class on the SVG every 15–30s at random; the CSS does the actual
// tongue/paw/eye-squint animation. If this module fails to load, the cat
// still blinks and breathes — it just never licks.

export const LICK_MIN_MS = 15000;
export const LICK_MAX_MS = 30000;
export const LICK_MS = 900;

/** Random delay until the next lick, 15–30s. `random` is injectable for tests. */
export function nextLickDelayMs(random = Math.random) {
  return LICK_MIN_MS + random() * (LICK_MAX_MS - LICK_MIN_MS);
}

/**
 * Toggle `.licking` on `root` on a randomized schedule. Returns a stop
 * function. No-ops outside a DOM (node imports). `setTimeoutFn` /
 * `clearTimeoutFn` are injectable so tests can drive the schedule without
 * waiting.
 */
export function scheduleLicks(
  root,
  { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random } = {},
) {
  if (!root || typeof root.classList === "undefined") return () => {};
  let stopped = false;
  const pending = new Set();
  const later = (fn, ms) => {
    const id = setTimeoutFn(() => {
      pending.delete(id);
      if (!stopped) fn();
    }, ms);
    pending.add(id);
    return id;
  };
  const tick = () => {
    later(() => {
      root.classList.add("licking");
      later(() => root.classList.remove("licking"), LICK_MS);
      tick();
    }, nextLickDelayMs(random));
  };
  tick();
  return () => {
    stopped = true;
    for (const id of pending) clearTimeoutFn(id);
    pending.clear();
    root.classList.remove("licking");
  };
}

if (typeof document !== "undefined") {
  const el = document.querySelector(".brand-cat");
  if (el) scheduleLicks(el);
}
