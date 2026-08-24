// PM2 process definitions for DigiShack (no Docker, per spec).
//
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
//   pm2 logs digishack-web
//
// Two processes by design:
//   digishack-web     — the Next.js app (stateless HTTP)
//   digishack-bridge  — the radio service: owns the radio, decodes, transmits
//
// The bridge is a separate process because it binds a UDP socket, and a bound
// UDP socket cannot be shared across cluster workers. Keeping it out of the web
// process is what lets the web tier scale later.

module.exports = {
  apps: [
    {
      name: "digishack-web",
      script: "node_modules/next/dist/bin/next",
      // -H 127.0.0.1, and this is the line that matters rather than package.json's
      // `start` script.
      //
      // PM2 runs `script` with these `args` directly; it never invokes npm, so editing
      // `"start": "next start -H 127.0.0.1"` in package.json changes nothing about the
      // running process. That was tried first and the port stayed open, which is the
      // useful thing to know here.
      //
      // Next binds 0.0.0.0 by default, and an unauthenticated sweep of the live install
      // found `http://<lan-ip>:3000` serving the application directly, past nginx.
      // Authentication still held there — that was checked, not assumed — so nothing was
      // exposed; what was bypassed was nginx's 64 MB body limit, its access log and its
      // header handling, including the real-client-address rewrite the login throttle
      // depends on. nginx proxies to 127.0.0.1:3000, so loopback is all it ever needed.
      args: "start -H 127.0.0.1",
      cwd: __dirname,
      // fork + 1 instance for now. Clustering the web tier is safe ONLY once
      // realtime fan-out lives in the bridge / Redis pub/sub rather than in
      // per-process memory. Do not raise this until then.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      out_file: "logs/web-out.log",
      error_file: "logs/web-err.log",
      merge_logs: true,
      time: true,
    },

    {
      name: "digishack-bridge",
      // tsx's real entry point, NOT node_modules/.bin/tsx.
      //
      // `.bin/tsx` is a shell script — the npm shim — and PM2 runs `script` through
      // `node`. On Linux that happens to work often enough to look fine; on Windows
      // Node reads the shim as JavaScript and dies on its first line with
      // "SyntaxError: missing ) after argument list" from `sed -e 's,\\,/,g'`. With
      // autorestart on, that is a silent crash loop: PM2 shows the app as present,
      // the radio never comes up, and the reason is buried in logs/bridge-err.log.
      //
      // The second reason the bridge has never started on a clean PM2 install — the
      // first was this entry pointing at a directory that had been renamed.
      script: "node_modules/tsx/dist/cli.mjs",
      // services/radio, not services/omega-bridge. The directory was renamed and
      // this was left behind, so `pm2 start ecosystem.config.js` started a process
      // that died instantly and, with autorestart and no max_restarts, flapped
      // forever. The radio has never come up on a clean PM2 install.
      args: "services/radio/index.ts",
      cwd: __dirname,
      exec_mode: "fork",
      // MUST stay 1. The bridge binds a UDP socket, and a bound UDP
      // socket cannot be shared across cluster workers — a second instance would
      // either fail to bind or silently steal half the datagrams.
      instances: 1,
      autorestart: true,
      // Without these a restart loop is invisible and unbounded. min_uptime plus
      // max_restarts makes PM2 give up and mark the process errored, which is what
      // you want when the cause is a missing database rather than a transient
      // crash — main() exits 1 on its first DB read.
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      // The default 1600 ms can SIGKILL mid-transmission, and the process.once
      // unkey hooks do not survive SIGKILL. Give shutdown room to unkey the radio.
      kill_timeout: 8000,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
      out_file: "logs/bridge-out.log",
      error_file: "logs/bridge-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
