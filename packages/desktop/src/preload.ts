/**
 * The bridge. plans/38 §3, §9.
 *
 * ONE object, `window.desktop`, and it is an allowlist of named functions.
 * There is no `invoke(channel, args)` here and there must never be one: a
 * generic bridge is `nodeIntegration` with extra steps, reachable by anything
 * that gets script execution in a renderer that displays agent output.
 *
 * It is nearly empty on purpose. Everything the client needs is already a
 * route on the controller, and the rule for adding to this file is that HTTP
 * genuinely cannot do the job — a native dialog, the OS keychain, a window
 * control. "It would be tidier" is not a reason.
 *
 * Phase 4 adds `pickDir`; phase 5 adds the key. Until then this exists so the
 * client can tell it is running in the app at all, which is the one thing it
 * cannot find out from a fetch.
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  /** Frozen: the renderer must not be able to redress this as something else. */
  version: process.versions.electron,
  platform: process.platform,
});
