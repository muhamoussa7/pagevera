// Runs content/agent.js inside a private isolated world created through CDP.
// This needs no host permission or activeTab grant, and the page's own scripts
// can't see or tamper with it. Works for the top frame and for child frames,
// including out-of-process ones reached through a child session.

let sourcePromise = null;

function loadSource() {
  sourcePromise ??= Promise.all(
    ['content/selectors.js', 'content/agent.js'].map((p) =>
      fetch(chrome.runtime.getURL(p)).then((r) => r.text()),
    ),
  ).then(([selectors, agent]) => `${selectors}\n;\n${agent}\n//# sourceURL=pagevera-agent.js`);
  return sourcePromise;
}

export async function createAgent(session, { sessionId = null, frameId = null } = {}) {
  if (!frameId) {
    const { frameTree } = await session.send('Page.getFrameTree', {}, { sessionId });
    frameId = frameTree.frame.id;
  }
  const { executionContextId } = await session.send(
    'Page.createIsolatedWorld',
    { frameId, worldName: 'pagevera', grantUniveralAccess: false },
    { sessionId },
  );
  await evaluate(session, sessionId, executionContextId, await loadSource(), { awaitPromise: false });

  return {
    contextId: executionContextId,
    sessionId,
    frameId,
    call(method, args = [], { timeoutMs = 60_000 } = {}) {
      checkMethod(method);
      const expr = `globalThis.__p2p.${method}(...${JSON.stringify(args)})`;
      return evaluate(session, sessionId, executionContextId, expr, { awaitPromise: true, timeoutMs });
    },
    // Calls an agent method with a DOM node of this frame as the first argument.
    async callOnNode(backendNodeId, method, args = []) {
      checkMethod(method);
      const { object } = await session.send(
        'DOM.resolveNode',
        { backendNodeId, executionContextId },
        { sessionId },
      );
      const r = await session.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: `function (...args) { return globalThis.__p2p.${method}(this, ...args); }`,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        },
        { sessionId },
      );
      session.send('Runtime.releaseObject', { objectId: object.objectId }, { sessionId }).catch(() => {});
      if (r.exceptionDetails) throw new Error(`Page script error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result?.value;
    },
  };
}

function checkMethod(method) {
  if (!/^[A-Za-z]+$/.test(method)) throw new Error(`Bad agent method ${method}`);
}

async function evaluate(session, sessionId, contextId, expression, { awaitPromise, timeoutMs = 60_000 }) {
  let r;
  try {
    r = await session.send(
      'Runtime.evaluate',
      { expression, contextId, awaitPromise, returnByValue: true },
      { timeoutMs: timeoutMs + 5000, sessionId },
    );
  } catch (e) {
    if (/Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(String(e?.message))) {
      const err = new Error('The page navigated or reloaded during the save.');
      err.code = 'NAVIGATED';
      throw err;
    }
    throw e;
  }
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`Page script error: ${d.exception?.description || d.text}`);
  }
  return r.result?.value;
}
