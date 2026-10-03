// Finds every frame in the tab, including cross-origin iframes that run in their
// own process, and prepares the ones that hold real content so their full height
// prints (Chrome prints an iframe as just its visible window otherwise).

import { createAgent } from './agent-host.js';
import { sleep } from './net-idle.js';

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
const MIN_FRAME_W = 300;
const MIN_FRAME_H = 150;

/** Returns [{sessionId, frameId, parentFrameId, url, depth}], top frame first. */
export async function discoverFrames(session) {
  const sessionIds = [null];
  const pending = [];
  const off = session.on('Target.attachedToTarget', (p) => {
    if (p.targetInfo?.type !== 'iframe') return;
    sessionIds.push(p.sessionId);
    // Nested out-of-process frames attach to their parent's session.
    pending.push(session.send('Target.setAutoAttach', AUTO_ATTACH, { sessionId: p.sessionId }).catch(() => {}));
  });
  try {
    await session.send('Target.setAutoAttach', AUTO_ATTACH);
    let seen = -1;
    for (let i = 0; i < 20 && seen !== sessionIds.length; i++) {
      seen = sessionIds.length;
      await sleep(150);
      await Promise.all(pending.splice(0));
    }
  } catch {
    // Auto-attach unavailable: only same-process frames will be found.
  } finally {
    off();
  }

  const frames = [];
  for (const sessionId of sessionIds) {
    try {
      const { frameTree } = await session.send('Page.getFrameTree', {}, { sessionId });
      const walk = (node) => {
        frames.push({ sessionId, frameId: node.frame.id, parentFrameId: node.frame.parentId || null, url: node.frame.url });
        (node.childFrames || []).forEach(walk);
      };
      walk(frameTree);
    } catch {
      // Frame went away.
    }
  }
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  for (const f of frames) {
    let depth = 0;
    for (let p = byId.get(f.parentFrameId); p; p = byId.get(p.parentFrameId)) depth++;
    f.depth = depth;
  }
  return frames.sort((a, b) => a.depth - b.depth);
}

/**
 * Creates an agent in every child frame big enough to be content.
 * Returns [{frame, agent, info}] and the distinct child session ids.
 */
export async function createFrameAgents(session, frames) {
  const out = [];
  for (const frame of frames) {
    if (frame.depth === 0 || /^(about:|chrome|data:|javascript:)/.test(frame.url)) continue;
    try {
      const agent = await createAgent(session, { sessionId: frame.sessionId, frameId: frame.frameId });
      const info = await agent.call('init');
      const m = await agent.call('measure');
      if (m.innerW < MIN_FRAME_W || m.innerH < MIN_FRAME_H) continue;
      out.push({ frame, agent, info, m });
    } catch {
      // Frame we can't script (blocked or gone). It prints as it is.
    }
  }
  const childSessions = [...new Set(out.map((f) => f.frame.sessionId).filter(Boolean))];
  return { frameAgents: out, childSessions };
}

/**
 * After a frame's own layout pass: grow its <iframe> element in the parent to the
 * frame's content height, then pin anything in the frame that depended on its
 * old viewport height. Returns the final height or null when nothing changed.
 */
export async function expandFrame(session, entry, parentAgent, report, grid = null) {
  const { frame, agent } = entry;
  // Size to the last visible content, not the full scroll height: trailing
  // padding would otherwise spill onto an extra, empty page. When we know where
  // the page edges fall, never let empty space cross one.
  const target = (mm) => {
    let t = Math.min(mm.scrollH, mm.contentBottom + 8);
    if (grid) {
      const pageEnd = Math.ceil((grid.top + mm.contentBottom) / grid.pageH) * grid.pageH;
      if (grid.top + t > pageEnd) t = Math.max(mm.contentBottom, pageEnd - grid.top - 1);
    }
    return t;
  };
  let m = await agent.call('measure');
  if (target(m) <= m.innerH + 4 && m.scrollH <= m.innerH + 4) return null;

  await agent.call('vhSnapshot', [], { timeoutMs: 60_000 });
  const ownerId = await ownerNode(session, entry, parentAgent);
  let height = target(m);
  for (let round = 0; round < 3; round++) {
    const res = await parentAgent.callOnNode(ownerId, 'expandFrameOwner', [height]);
    await agent.call('settle', [2]);
    const frozen = await agent.call('vhFreeze', [], { timeoutMs: 60_000 });
    m = await agent.call('measure');
    report.push({ url: frame.url.slice(0, 120), from: res.before, to: height, frozen: frozen.frozen, now: target(m) });
    if (Math.abs(target(m) - height) <= 4) break;
    height = target(m);
  }
  return height;
}

// The <iframe> element (in the parent frame) that hosts this frame.
async function ownerNode(session, entry, parentAgent) {
  if (!entry.ownerNodeId) {
    const owner = await session.send('DOM.getFrameOwner', { frameId: entry.frame.frameId }, { sessionId: parentAgent.sessionId });
    entry.ownerNodeId = owner.backendNodeId;
  }
  return entry.ownerNodeId;
}

/**
 * Chrome prints an iframe as one picture sliced at each page boundary. Work out
 * where every frame starts on the page grid of the top document, then let the
 * innermost frames move content off the boundaries and grow their iframes again.
 */
export async function paginateFrames(session, rootAgent, frameAgents, pageH, report) {
  const parentOf = (e) => {
    if (e.frame.parentFrameId === rootAgent.frameId) return { agent: rootAgent, entry: null };
    const p = frameAgents.find((x) => x.frame.frameId === e.frame.parentFrameId);
    return p ? { agent: p.agent, entry: p } : null;
  };
  const tops = new Map();
  for (const e of [...frameAgents].sort((a, b) => a.frame.depth - b.frame.depth)) {
    const par = parentOf(e);
    if (!par || (par.entry && !tops.has(par.entry))) continue;
    const box = await par.agent.callOnNode(await ownerNode(session, e, par.agent), 'nodeBox');
    let top = (par.entry ? tops.get(par.entry) : 0) + box.top;
    if (!par.entry) {
      // A top-level iframe that doesn't fit in what's left of its page moves to the next one.
      const inPage = top % pageH;
      if (inPage > 1 && inPage + box.height > pageH) top += pageH - inPage;
    }
    tops.set(e, top);
  }
  let pushed = 0;
  for (const e of [...frameAgents].sort((a, b) => b.frame.depth - a.frame.depth)) {
    if (!tops.has(e)) continue;
    const r = await e.agent.call('paginate', [{ pageH, offset: tops.get(e) % pageH }], { timeoutMs: 60_000 });
    report.push({ url: e.frame.url.slice(0, 80), offset: Math.round(tops.get(e) % pageH), ...r });
    if (!r.pushed) continue;
    pushed += r.pushed;
    // Content got taller: grow this iframe and every iframe around it.
    for (let cur = e; cur; ) {
      const par = parentOf(cur);
      if (!par) break;
      await expandFrame(session, cur, par.agent, report, { pageH, top: tops.get(cur) });
      cur = par.entry;
    }
  }
  // Check: nothing should be left on a page edge.
  for (const e of frameAgents) {
    if (!tops.has(e)) continue;
    const left = await e.agent.call('paginate', [{ pageH, offset: tops.get(e) % pageH, dryRun: true }]).catch(() => null);
    if (left?.straddling) report.push({ url: e.frame.url.slice(0, 80), stillOnEdge: left.straddling, examples: left.examples });
  }
  return pushed;
}
