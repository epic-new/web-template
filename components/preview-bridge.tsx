'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * The preview's half of the postMessage bridge.
 *
 * A prototype runs in a cross-origin iframe inside the Epic workspace. Neither
 * side can read the other's location, so the two talk in messages: this
 * component says where the preview is, and answers the two questions the host
 * is allowed to ask.
 *
 * Mounted once in the root layout so it survives every route change.
 * **Do not delete it when rebuilding the app** — without it the workspace's
 * address bar goes blank and screen switching stops working, in a way that
 * looks like the host is broken.
 *
 * Inert outside an iframe, and inert inside one whose parent origin is not
 * recognised. A prototype opened directly in a browser tab has nobody to talk
 * to, and a wrong `targetOrigin` would post this frame's location to a stranger.
 *
 * **This is location and navigation, and nothing else.** The annotation
 * toolbar talks to the workspace on its own, from the bundle Epic serves —
 * because that bundle can be fixed by a deploy while this file stays frozen
 * inside a Docker image for months. Anything routed through here would have
 * pinned the whole feature to whichever template version a machine was built
 * from.
 *
 * `docs/references/preview-bridge.md` is the contract, written for whoever
 * implements the host side.
 */

/**
 * Still 1, and it should stay 1 for a long time.
 *
 * An unknown **type** and an unknown **version** fail differently. A parser
 * that meets a type it does not know ignores that one message; a parser that
 * meets a version it does not know throws away the envelope, location and all.
 * Snapshots outlive deployments in both directions, so a preview and a host
 * are routinely one change apart — and adding types keeps that harmless, while
 * bumping the version would make an old host go blind rather than merely deaf.
 *
 * Raise it only if the *envelope* changes: `source`, `revision`, `requestId`,
 * or the location payload. Adding a message is not that.
 */
const VERSION = 1;

/** How often the location is checked, and how quickly the host hears about it. */
const POLL_MS = 500;

/** How long without any message before one is sent anyway, as a recovery path. */
const HEARTBEAT_MS = 10_000;

type PreviewState = {
  href: string;
  path: string;
  search: string;
  hash: string;
  title: string;
};

/**
 * Query parameters this frame will never report.
 *
 * A preview is reached through a gate that takes a bearer token in the URL —
 * `?_proxy_token=…` — and swaps it for a cookie on the first request. That swap
 * is the gate's job and it does not always happen: with no secret configured
 * the gate is disabled entirely and the parameter simply stays in the address.
 *
 * Reporting it would hand a credential to whatever the host does with this
 * message next: render it in a field somebody can copy, log it, put it in a
 * prompt. So it is stripped here, at the only point that knows the URL is a
 * location and not a secret. The list is deliberately broader than the one
 * parameter we ship with — this frame cannot know what the next gate calls its
 * token.
 */
const CREDENTIAL_PARAMS = /^(_proxy_token|token|access_token|auth|api_key|apikey|key|secret|signature|sig|password)$/i;

/** The location, with anything that looks like a credential taken out of it. */
function safeLocation(): { href: string; search: string } {
  const url = new URL(window.location.href);
  for (const name of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAMS.test(name)) url.searchParams.delete(name);
  }
  return { href: url.href, search: url.search };
}

type HostMessage =
  | { type: 'host:get-state'; requestId: string }
  | { type: 'host:navigate'; requestId: string; path: string };

/**
 * Which parent origins this preview will talk to.
 *
 * The ones `NEXT_PUBLIC_PREVIEW_HOST_ORIGIN` names, comma-separated: Epic sets
 * it to its workspace on the machines it runs, so the workspace can move to
 * another host without this file changing in every project already created.
 * Unset, only a local workspace is trusted, so a fresh checkout still works
 * and a deployed app framed by a stranger stays silent.
 */
export function isAllowedHost(origin: string): boolean {
  const configured = (process.env.NEXT_PUBLIC_PREVIEW_HOST_ORIGIN ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured.includes(origin);

  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * The parent's origin, which this frame is not allowed to simply read.
 *
 * `ancestorOrigins` answers directly in Chromium and WebKit; Firefox leaves the
 * referrer, which a host can also suppress. No answer means no bridge.
 */
export function resolveHost(): string | null {
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor) return isAllowedHost(ancestor) ? ancestor : null;

  try {
    const { origin } = new URL(document.referrer);
    return isAllowedHost(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * A host message, or null for anything that is not one.
 *
 * Hand-written rather than a schema: it is two shapes, it runs in the browser
 * bundle, and every rejection here is a security decision worth reading in
 * place.
 */
function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;

  if (message.source !== 'epic-host' || message.version !== VERSION) return null;
  if (typeof message.requestId !== 'string' || !message.requestId) return null;

  if (message.type === 'host:get-state') {
    return { type: 'host:get-state', requestId: message.requestId };
  }

  if (message.type === 'host:navigate') {
    const path = (message.payload as { path?: unknown } | undefined)?.path;
    // A path on this origin, and nothing else. `//evil.example` and `/\evil`
    // both start with a slash and both leave this origin — which would hand the
    // workspace's preview pane to a page nobody here controls.
    if (typeof path !== 'string') return null;
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
      return null;
    }
    return { type: 'host:navigate', requestId: message.requestId, path };
  }

  return null;
}

function readState(): PreviewState {
  const { pathname, hash } = window.location;
  const { href, search } = safeLocation();
  return { href, path: pathname, search, hash, title: document.title };
}

export function PreviewBridge() {
  const pathname = usePathname();
  const router = useRouter();

  /**
   * The router, read through a ref so the connect effect below can run exactly
   * once. Depending on `router` directly reconnects the bridge — a second
   * `preview:ready`, a second timer — every time its identity changes, which is
   * a promise Next does not make.
   */
  const latestRouter = useRef(router);
  useEffect(() => {
    latestRouter.current = router;
  }, [router]);

  /** Everything the bridge remembers, in one place. */
  const bridge = useRef({
    host: null as string | null,
    revision: 0,
    href: '',
    sentAt: 0,
    /** Set once the host is known; null means there is nobody to talk to. */
    send: null as null | ((type: string, requestId?: string) => void),
  });

  useEffect(() => {
    if (window.parent === window) return;

    const state = bridge.current;
    state.host = resolveHost();
    if (!state.host) return;

    const send = (state.send = (type: string, requestId?: string) => {
      state.revision += 1;
      state.href = window.location.href;
      state.sentAt = Date.now();
      window.parent.postMessage(
        {
          source: 'epic-preview',
          version: VERSION,
          type,
          revision: state.revision,
          ...(requestId ? { requestId } : {}),
          payload: readState(),
        },
        state.host as string
      );
    });

    function onMessage(event: MessageEvent) {
      // The origin says who sent it; the source says which window did, so
      // another frame on the host's origin cannot drive this one.
      if (event.origin !== state.host || event.source !== window.parent) return;

      const message = parseHostMessage(event.data);
      if (!message) return;

      if (message.type === 'host:navigate') latestRouter.current.push(message.path);
      // Either way the host gets an authoritative snapshot back. For a
      // navigation this is the acknowledgement; where it lands is reported by
      // the poll below, once it has landed.
      send('preview:state', message.requestId);
    }

    /**
     * One timer, two jobs.
     *
     * Polling the location is what makes this bridge true for *any* navigation
     * — a `<Link>`, a hash link, the back button, a query-only push, a
     * hand-written `pushState` in code the agent writes next. The alternative
     * was patching `history` and reconciling it with the router's own events,
     * which reported every route change twice.
     *
     * When nothing has moved, a message still goes out every `HEARTBEAT_MS`, so
     * a host that attached its listener late recovers on its own.
     */
    function tick() {
      if (document.visibilityState !== 'visible') return;
      if (window.location.href !== state.href) send('preview:navigation');
      else if (Date.now() - state.sentAt >= HEARTBEAT_MS) send('preview:sync');
    }

    window.addEventListener('message', onMessage);
    const timer = window.setInterval(tick, POLL_MS);

    send('preview:ready');

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
      state.send = null;
    };
  }, []);

  // The poll would catch this within half a second; reporting it here makes the
  // ordinary case immediate. Same guard, so one navigation is still one message.
  useEffect(() => {
    const state = bridge.current;
    if (window.location.href !== state.href) state.send?.('preview:navigation');
  }, [pathname]);

  return null;
}
