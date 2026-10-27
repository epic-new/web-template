// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
let pathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

import { PreviewBridge } from './preview-bridge';

const HOST = 'https://build.epic.new';

type Posted = { message: Record<string, unknown>; targetOrigin: string };
let posted: Posted[] = [];

/**
 * jsdom runs every test in one window, so "inside an iframe" has to be staged:
 * a parent that is not `window`, and an ancestor origin for the frame to
 * recognise.
 */
function frameInsideHost(origin: string | null = HOST) {
  const parent = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
      posted.push({ message, targetOrigin });
    },
  };

  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  Object.defineProperty(window.location, 'ancestorOrigins', {
    value: origin ? ([origin] as unknown as DOMStringList) : [],
    configurable: true,
  });

  return parent;
}

function fromHost(data: unknown, source: unknown, origin = HOST) {
  window.dispatchEvent(
    new MessageEvent('message', { data, origin, source: source as Window })
  );
}

const getState = (requestId = 'req-1') => ({
  source: 'epic-host',
  version: 1,
  type: 'host:get-state',
  requestId,
});

const navigate = (path: string, requestId = 'nav-1') => ({
  source: 'epic-host',
  version: 1,
  type: 'host:navigate',
  requestId,
  payload: { path },
});

/** Nothing arrived while we waited. */
async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PreviewBridge', () => {
  beforeEach(() => {
    posted = [];
    push.mockClear();
    pathname = '/';
    window.history.replaceState({}, '', '/');
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_HOST_ORIGIN', HOST);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
  });

  describe('connecting', () => {
    it('announces itself to the host with its current location', async () => {
      frameInsideHost();

      render(<PreviewBridge />);

      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]?.targetOrigin).toBe(HOST);
      expect(posted[0]?.message).toMatchObject({
        source: 'epic-preview',
        version: 1,
        type: 'preview:ready',
        revision: 1,
        payload: { path: '/', href: expect.stringContaining('/') },
      });
    });

    it('stays silent when it is not inside a frame', async () => {
      render(<PreviewBridge />);

      await settle();
      expect(posted).toEqual([]);
    });

    it.each([
      ['a sandbox on the preview proxy', 'https://8080-abc123.proxy.epic.new'],
      ['another host on the same domain', 'https://epic.new'],
    ])('stays silent inside a frame hosted by %s', async (_label, origin) => {
      // Only the origins the environment names: one prototype framing another
      // used to pass on the strength of a shared `.epic.new` suffix.
      frameInsideHost(origin);

      render(<PreviewBridge />);

      await settle();
      expect(posted).toEqual([]);
    });

    it('talks to any of the hosts the environment names', async () => {
      vi.stubEnv('NEXT_PUBLIC_PREVIEW_HOST_ORIGIN', `https://staging.epic.new, ${HOST}`);
      frameInsideHost(HOST);

      render(<PreviewBridge />);

      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]?.targetOrigin).toBe(HOST);
    });

    it.each([
      ['a local workspace', 'http://localhost:3000', true],
      ['a hosted workspace', 'https://build.epic.new', false],
    ])('with no host named, talks to %s: %s', async (_label, origin, talks) => {
      vi.stubEnv('NEXT_PUBLIC_PREVIEW_HOST_ORIGIN', '');
      frameInsideHost(origin);

      render(<PreviewBridge />);

      if (talks) {
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]?.targetOrigin).toBe(origin);
      } else {
        await settle();
        expect(posted).toEqual([]);
      }
    });

    it('stays silent inside a frame whose parent origin is not recognised', async () => {
      frameInsideHost('https://somewhere-else.example');

      render(<PreviewBridge />);

      await settle();
      expect(posted).toEqual([]);
    });

    it('stays silent when the parent origin cannot be resolved at all', async () => {
      frameInsideHost(null);

      render(<PreviewBridge />);

      await settle();
      expect(posted).toEqual([]);
    });
  });

  describe('answering the host', () => {
    it('replies to host:get-state with the request id it was given', async () => {
      const parent = frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(getState('req-7'), parent);

      await waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[1]?.message).toMatchObject({
        type: 'preview:state',
        requestId: 'req-7',
        // Monotonic, so a delayed message can never overwrite newer state.
        revision: 2,
      });
    });

    it('navigates on host:navigate and acknowledges it', async () => {
      const parent = frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(navigate('/tasks'), parent);

      await waitFor(() => expect(push).toHaveBeenCalledWith('/tasks'));
      expect(posted[1]?.message).toMatchObject({
        type: 'preview:state',
        requestId: 'nav-1',
      });
    });
  });

  describe('refusing what it should refuse', () => {
    it('ignores a message from another window on the host origin', async () => {
      frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(getState(), { name: 'another frame' });

      await settle();
      expect(posted).toHaveLength(1);
    });

    it('ignores a message from another origin', async () => {
      const parent = frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(getState(), parent, 'https://evil.example');

      await settle();
      expect(posted).toHaveLength(1);
    });

    it.each([
      ['a wrong source', { ...getState(), source: 'someone-else' }],
      ['an unknown version', { ...getState(), version: 3 }],
      ['no request id', { ...getState(), requestId: '' }],
      ['an unknown type', { ...getState(), type: 'host:destroy' }],
      ['nothing at all', null],
      ['a string', 'host:get-state'],
    ])('ignores %s', async (_label, data) => {
      const parent = frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(data, parent);

      await settle();
      expect(posted).toHaveLength(1);
    });

    it.each([
      ['an absolute URL', 'https://evil.example/'],
      ['a protocol-relative URL', '//evil.example/'],
      ['a backslash-escaped URL', '/\\evil.example/'],
      ['a relative path', 'tasks'],
      ['a number', 42],
    ])('refuses to navigate to %s', async (_label, path) => {
      const parent = frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      fromHost(navigate(path as string), parent);

      await settle();
      expect(push).not.toHaveBeenCalled();
      expect(posted).toHaveLength(1);
    });
  });

  describe('keeping credentials out of what it reports', () => {
    it('never reports the proxy token that let the frame load', async () => {
      frameInsideHost();
      window.history.replaceState({}, '', '/?_proxy_token=super-secret&tab=plans');

      render(<PreviewBridge />);

      await waitFor(() => expect(posted).toHaveLength(1));
      const payload = (posted[0]?.message as { payload: Record<string, string> })
        .payload;
      // The gate swaps this parameter for a cookie on the first request — and
      // does not, when it is configured with no secret. Either way it is a
      // bearer credential, and the host would render it in a field somebody can
      // copy.
      expect(JSON.stringify(payload)).not.toContain('super-secret');
      // What the app itself put in the URL is not a secret and stays.
      expect(payload.search).toBe('?tab=plans');
      expect(payload.path).toBe('/');
    });

    it.each(['token', 'access_token', 'api_key', 'signature', 'password'])(
      'strips ?%s= as well',
      async (name) => {
        frameInsideHost();
        window.history.replaceState({}, '', `/?${name}=leaked`);

        render(<PreviewBridge />);

        await waitFor(() => expect(posted).toHaveLength(1));
        expect(JSON.stringify(posted[0]?.message)).not.toContain('leaked');
      }
    );

    it('still reports a navigation that only changes a stripped parameter', async () => {
      frameInsideHost();
      window.history.replaceState({}, '', '/');
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      // The dedupe compares the real location, so this counts as a move even
      // though what goes out looks the same. Reporting it is the honest
      // answer: the frame did navigate.
      window.history.pushState({}, '', '/?_proxy_token=another');

      await waitFor(() => expect(posted).toHaveLength(2), { timeout: 1500 });
      expect(JSON.stringify(posted[1]?.message)).not.toContain('another');
    });
  });

  describe('reporting navigation', () => {
    it('reports a route change once, not once per observer', async () => {
      frameInsideHost();
      const { rerender } = render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      // What a route change is: history moves, then the component re-renders
      // with a new pathname. The poll sees the same move.
      window.history.pushState({}, '', '/tasks');
      pathname = '/tasks';
      rerender(<PreviewBridge />);

      await waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[1]?.message).toMatchObject({
        type: 'preview:navigation',
        revision: 2,
        payload: { path: '/tasks' },
      });

      // Long enough for the poll to have run and found nothing new.
      await settle(700);
      expect(posted).toHaveLength(2);
    });

    it('reports a query-only change, which the route hook never sees', async () => {
      frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      window.history.pushState({}, '', '/?status=done');

      await waitFor(() => expect(posted).toHaveLength(2), { timeout: 1500 });
      expect(posted[1]?.message).toMatchObject({
        type: 'preview:navigation',
        payload: { path: '/', search: '?status=done' },
      });
    });

    it('reports a hash change', async () => {
      frameInsideHost();
      render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      window.location.hash = '#section';

      await waitFor(() => expect(posted).toHaveLength(2), { timeout: 1500 });
      expect(posted[1]?.message).toMatchObject({
        type: 'preview:navigation',
        payload: { hash: '#section' },
      });
    });

    it('says nothing when a re-render does not move the location', async () => {
      frameInsideHost();
      const { rerender } = render(<PreviewBridge />);
      await waitFor(() => expect(posted).toHaveLength(1));

      rerender(<PreviewBridge />);

      await settle(700);
      expect(posted).toHaveLength(1);
    });
  });

});
