import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SpaceRoot } from './SpaceRoot.tsx';

let spaceUiRoot: Root | null = null;

/**
 * Mount synchronously so legacy engine adapters can bind the React-created DOM
 * during their constructors without racing React's concurrent root scheduling.
 */
export function mountSpaceUi(): Root {
  const host = document.getElementById('space-react-root');
  if (!host) throw new Error('Missing #space-react-root host');
  if (!spaceUiRoot) spaceUiRoot = createRoot(host);
  flushSync(() => {
    spaceUiRoot!.render(<SpaceRoot />);
  });
  return spaceUiRoot;
}
