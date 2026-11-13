// Preloaded into a spawned sync-cli (NODE_OPTIONS=--require) to observe it:
// records os.setPriority calls and console.log lines in order, and can keep
// the process alive for SHIM_HOLD_MS, standing in for a long-running sync.
const fs = require('fs');
const os = require('os');

const record = (event) => fs.appendFileSync(process.env.SHIM_EVENTS, event + '\n');

const setPriority = os.setPriority;
os.setPriority = (pid, priority) => {
  record(`setPriority:${pid}:${priority}`);
  return setPriority(pid, priority);
};

const log = console.log;
console.log = (...args) => {
  record('log:' + args.join(' '));
  log(...args);
};

const holdMs = Number(process.env.SHIM_HOLD_MS || 0);
if (holdMs > 0) {
  const keepAlive = setInterval(() => {}, 1000);
  setTimeout(() => clearInterval(keepAlive), holdMs);
}
