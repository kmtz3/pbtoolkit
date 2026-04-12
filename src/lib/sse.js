/**
 * Server-Sent Events helper.
 * Sets the correct headers and provides typed event emitters.
 */

/**
 * Start an SSE response.
 * @param {import('express').Response} res
 * @returns {{ progress, complete, error, done }}
 */
function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Must listen on `res`, not `req`. req 'close' fires on HTTP half-close
  // (request body consumed) before any rows are processed, causing premature abort.
  // res 'close' only fires when the client actually disconnects from the SSE stream.
  let aborted = false;
  res.on('close', () => { clearInterval(heartbeat); aborted = true; });
  // Also catch socket-level errors (e.g. ECONNRESET) which fire before 'close'
  res.on('error', () => { clearInterval(heartbeat); aborted = true; });

  // Heartbeat keeps the connection alive and also detects a broken write path:
  // if the browser stopped reading but kept the TCP connection open, the OS send
  // buffer will eventually fill and res.write() will throw — setting aborted here
  // ensures the server-side loop detects the abort within one heartbeat interval.
  const heartbeat = setInterval(() => {
    if (aborted) return;
    try { res.write(':\n\n'); } catch { aborted = true; clearInterval(heartbeat); }
  }, 5000);

  const send = (event, data) => {
    if (aborted) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      aborted = true;
    }
  };

  return {
    /** Send a progress update */
    progress: (message, percent, detail = null) =>
      send('progress', { message, percent, detail }),

    /** Send a per-row log entry (streamed in real time during import) */
    log: (level, message, detail = null) =>
      send('log', { level, message, detail, ts: new Date().toISOString() }),

    /** Send completion event with result payload */
    complete: (data) => send('complete', { ...data }),

    /** Send an error event */
    error: (message, detail = null) => send('error', { message, detail }),

    /** End the SSE stream */
    done: () => res.end(),

    /** Returns true if the client disconnected or the socket was destroyed */
    isAborted: () => aborted || res.socket?.destroyed === true,
  };
}

module.exports = { startSSE };
