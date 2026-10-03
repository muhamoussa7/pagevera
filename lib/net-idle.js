// Tracks in-flight requests through CDP Network events so we can wait for the
// page to go quiet after scrolling or swapping images.

import { NET_QUIET_MAX_MS, NET_QUIET_MS, NET_STALE_MS } from './constants.js';

const IGNORED_TYPES = new Set(['EventSource', 'WebSocket', 'Ping', 'CSPViolationReport']);

export function createNetIdle(session) {
  const inflight = new Map(); // requestId -> start time
  const offs = [];

  // Request ids are only unique within one session (frame process).
  const key = (p, sessionId) => `${sessionId || 'root'}:${p.requestId}`;
  const done = (p, sessionId) => inflight.delete(key(p, sessionId));
  let sessions = [null];

  return {
    async start(childSessions = []) {
      offs.push(
        session.on('Network.requestWillBeSent', (p, sessionId) => {
          if (IGNORED_TYPES.has(p.type)) return;
          const url = p.request?.url || '';
          if (url.startsWith('data:') || url.startsWith('blob:')) return;
          inflight.set(key(p, sessionId), Date.now());
        }),
        session.on('Network.loadingFinished', done),
        session.on('Network.loadingFailed', done),
      );
      sessions = [null, ...childSessions];
      for (const sessionId of sessions) {
        await session
          .send('Network.enable', { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 }, { sessionId })
          .catch(() => {});
      }
    },

    active() {
      const now = Date.now();
      let n = 0;
      for (const [id, t] of inflight) {
        if (now - t > 60_000) inflight.delete(id);
        else if (now - t <= NET_STALE_MS) n++;
      }
      return n;
    },

    async waitQuiet({ quietMs = NET_QUIET_MS, maxMs = NET_QUIET_MAX_MS } = {}) {
      const start = Date.now();
      let quietSince = null;
      while (Date.now() - start < maxMs) {
        if (this.active() === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= quietMs) return true;
        } else {
          quietSince = null;
        }
        await sleep(100);
      }
      return false;
    },

    async stop() {
      offs.forEach((off) => off());
      offs.length = 0;
      inflight.clear();
      for (const sessionId of sessions) {
        if (session.attached) await session.send('Network.disable', {}, { sessionId }).catch(() => {});
      }
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
