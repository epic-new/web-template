// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewToolbarLoader } from './preview-toolbar-loader';

const HOST = 'https://build.epic.new';

/**
 * jsdom runs every test in one window, so "inside an iframe" has to be staged —
 * the same staging `preview-bridge.test.tsx` uses, because this component
 * deliberately reuses that file's host resolution.
 */
function frameInsideHost(origin: string | null = HOST) {
  Object.defineProperty(window, 'parent', {
    value: { postMessage: () => {} },
    configurable: true,
  });
  Object.defineProperty(window.location, 'ancestorOrigins', {
    value: origin ? ([origin] as unknown as DOMStringList) : [],
    configurable: true,
  });
}

const loaded = () =>
  [...document.head.querySelectorAll('script[data-epic-preview-toolbar-loader]')];

beforeEach(() => {
  document.head.innerHTML = '';
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_HOST_ORIGIN', HOST);
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
  Object.defineProperty(window.location, 'ancestorOrigins', {
    value: [] as unknown as DOMStringList,
    configurable: true,
  });
});

describe('PreviewToolbarLoader', () => {
  it('asks the workspace that framed it for the toolbar', async () => {
    frameInsideHost();

    render(<PreviewToolbarLoader />);

    await waitFor(() => expect(loaded()).toHaveLength(1));
    // Derived, never configured: whoever frames this preview serves its
    // toolbar, which is right in production and in a local workspace alike.
    expect(loaded()[0]?.getAttribute('src')).toBe(`${HOST}/api/preview-toolbar`);
  });

  it('loads nothing when the preview is open in its own tab', async () => {
    render(<PreviewToolbarLoader />);

    await waitFor(() => expect(loaded()).toHaveLength(0));
  });

  it('loads nothing for a host it does not recognise', async () => {
    frameInsideHost('https://evil.example');

    render(<PreviewToolbarLoader />);

    await waitFor(() => expect(loaded()).toHaveLength(0));
  });

  it('loads nothing when the parent origin cannot be resolved', async () => {
    frameInsideHost(null);

    render(<PreviewToolbarLoader />);

    await waitFor(() => expect(loaded()).toHaveLength(0));
  });

  it('does not stack a second copy on a re-render', async () => {
    frameInsideHost();

    const { rerender } = render(<PreviewToolbarLoader />);
    await waitFor(() => expect(loaded()).toHaveLength(1));

    rerender(<PreviewToolbarLoader />);
    render(<PreviewToolbarLoader />);

    await waitFor(() => expect(loaded()).toHaveLength(1));
  });

  it('takes its tag away when the workspace cannot serve it', async () => {
    frameInsideHost();
    render(<PreviewToolbarLoader />);
    await waitFor(() => expect(loaded()).toHaveLength(1));

    loaded()[0]?.dispatchEvent(new Event('error'));

    // The prototype is unaffected and says nothing: the person is here to look
    // at their app, not to hear that our chrome is down.
    await waitFor(() => expect(loaded()).toHaveLength(0));
  });
});
