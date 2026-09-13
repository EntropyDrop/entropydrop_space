import React, { useEffect } from 'react';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { Hud } from './components/Hud.tsx';
import { GlobalSettingsModal, PauseScreen } from './components/SimpleModals.tsx';
import { MinimapCanvas, NavigationPanel } from './components/WorldWidgets.tsx';
import { spaceUiStore } from './store/SpaceUiStore.ts';
import { useSpaceUi } from './store/useSpaceUi.ts';

const loadEditorModals = () => import('./components/EditorModal.tsx');
const InventoryModal = React.lazy(() => import('./components/InventoryModal.tsx')
  .then(module => ({ default: module.InventoryModal })));
const BuildAssistantModal = React.lazy(() => import('./components/BuildAssistantModal.tsx')
  .then(module => ({ default: module.BuildAssistantModal })));
const CodeEditorModal = React.lazy(() => loadEditorModals()
  .then(module => ({ default: module.CodeEditorModal })));
const ApiDocsModal = React.lazy(() => loadEditorModals()
  .then(module => ({ default: module.ApiDocsModal })));

function ModalChunkFallback() {
  return <div className="space-modal-loading" role="status">Loading interface…</div>;
}

export function SpaceRoot() {
  const { selectedColor, activeModal, apiDocsOpen } = useSpaceUi(state => state);

  useEffect(() => {
    document.documentElement.style.setProperty('--build-color', colorToHex(selectedColor));
  }, [selectedColor]);

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && spaceUiStore.handleEscape()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter'
        && spaceUiStore.getSnapshot().activeModal === 'code') {
        event.preventDefault();
        event.stopPropagation();
        spaceUiStore.applyAndRunScript();
        spaceUiStore.closeAllModals(true);
        spaceUiStore.showToast('Script saved & applied, back to the game!');
      }
    };

    // Prevent 2D UI buttons from retaining focus when clicked,
    // so game controls (e.g. Space for jump/fly) are never intercepted by focused buttons.
    const blurButton = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      const btn = el?.closest?.('button, [role="button"]') as HTMLElement | null;
      if (btn) btn.blur();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button')) {
        target.blur();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      blurButton(event.target);
    };
    const handleClick = (event: MouseEvent) => {
      blurButton(event.target);
    };

    window.addEventListener('keydown', handleGlobalKey, true);
    window.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKey, true);
      window.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, []);

  return (
    <>
      <div id="canvas-container" onClick={() => spaceUiStore.resumeFromCanvas()} />
      <Hud />
      <NavigationPanel />
      <MinimapCanvas />
      <GlobalSettingsModal />
      {activeModal === 'inventory' ? (
        <React.Suspense fallback={<ModalChunkFallback />}><InventoryModal /></React.Suspense>
      ) : null}
      {activeModal === 'code' || apiDocsOpen ? (
        <React.Suspense fallback={<ModalChunkFallback />}>
          <CodeEditorModal />
          <ApiDocsModal />
        </React.Suspense>
      ) : null}
      {activeModal === 'builder' ? (
        <React.Suspense fallback={<ModalChunkFallback />}><BuildAssistantModal /></React.Suspense>
      ) : null}
      <PauseScreen />
    </>
  );
}
