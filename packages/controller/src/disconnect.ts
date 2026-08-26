/**
 * Noticing that the reader has gone.
 *
 * This is one word of code and it was wrong, in the way that is hardest to
 * see: everything downstream was right. An AbortController was threaded
 * through the loop, the loop checked it every step, the shell killed whole
 * process groups. Only the wire that delivers the signal was attached to the
 * wrong event, so none of that machinery ever ran.
 *
 * THE TRAP. `req` is the request BODY stream. Its 'close' fires when the body
 * has been read — which, for a POST, is milliseconds into the handler and
 * before any listener registered after `await`-ing the body can hear it. It
 * does not fire again when the socket later drops. Measured, with a server
 * that copies the exact sequence:
 *
 *     body consumed at 19ms
 *     res 'close' at 360ms          <- the client actually disconnecting
 *     turn finished at 1027ms — aborted: false
 *
 * `res` is the connection. Its 'close' fires when the client goes, whether
 * that is the stop button aborting a fetch, a closed tab, or a dropped
 * network — and also, harmlessly, when the response ends normally.
 *
 * What it cost: the stop button said "stopped" and stopped nothing, and a
 * closed tab left a turn running to completion, billing the user for a page
 * nobody would ever see.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Call `gone` once, when the client is no longer there.
 *
 * @param req taken only to make the misuse impossible to reintroduce: the
 *            listener that belongs on `res` is registered here, next to the
 *            reason, rather than at the call site where `req` is in scope and
 *            looks like the obvious choice.
 */
export function onClientGone(
  _req: IncomingMessage, res: ServerResponse, gone: () => void,
): void {
  let fired = false;
  const once = () => { if (!fired) { fired = true; gone(); } };
  res.on("close", once);
  // A socket error is a disconnection too, and it does not always produce a
  // 'close' the same tick.
  res.on("error", once);
}
