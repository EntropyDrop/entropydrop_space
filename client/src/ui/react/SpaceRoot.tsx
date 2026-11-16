import React, { useEffect } from 'react';
import { colorToHex } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { Hud } from './components/Hud.tsx';
import { TextCreationPanel } from './components/TextCreationPanel.tsx';
import { GlobalSettingsModal, PauseScreen } from './components/SimpleModals.tsx';
import { MinimapCanvas, NavigationPanel } from './components/WorldWidgets.tsx';
import { spaceUiStore } from './store/SpaceUiStore.ts';
import { useSpaceUiFields } from './store/useSpaceUi.ts';

const loadEditorModals = () => import('./components/EditorModal.tsx');
const InventoryModal = React.lazy(() => import('./components/InventoryModal.tsx')
  .then(module => ({ default: module.InventoryModal })));
const AgentBuildModal = React.lazy(() => import('./components/AgentBuildModal.tsx')
  .then(module => ({ default: module.AgentBuildModal })));
const CodeEditorModal = React.lazy(() => loadEditorModals()
  .then(module => ({ default: module.CodeEditorModal })));
const ApiDocsModal = React.lazy(() => loadEditorModals()
  .then(module => ({ default: module.ApiDocsModal })));
const AdminMonitoringDashboard = React.lazy(() => import('./components/monitoring/AdminMonitoringDashboard.tsx')
  .then(module => ({ default: module.AdminMonitoringDashboard })));

function ModalChunkFallback() {
  return <div className="space-modal-loading" role="status">Loading interface…</div>;
}

export function SpaceRoot() {
  const { selectedColor, activeModal, apiDocsOpen, hasStarted, pointerLocked } = useSpaceUiFields(
    'selectedColor', 'activeModal', 'apiDocsOpen', 'hasStarted', 'pointerLocked',
  );
  const pauseOpen = !hasStarted || activeModal === 'help';
  const canResume = !pauseOpen && !pointerLocked && !activeModal && !apiDocsOpen;

  useEffect(() => {
    document.documentElement.style.setProperty('--build-color', colorToHex(selectedColor));
  }, [selectedColor]);

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      // The first Escape dismisses code suggestions, leaving the editor open.
      if (event.key === 'Escape' && event.target instanceof HTMLElement
        && event.target.dataset.codeCompletionsOpen === 'true') return;
      if (event.key === 'Escape' && spaceUiStore.getSnapshot().activeModal !== 'settings' && spaceUiStore.handleEscape()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter'
        && spaceUiStore.getSnapshot().activeModal === 'code') {
        event.preventDefault();
        event.stopPropagation();
        spaceUiStore.closeAllModals(true);
        spaceUiStore.showToast('Script saved, back to the game!');
      }
    };

    window.addEventListener('keydown', handleGlobalKey, true);
    return () => window.removeEventListener('keydown', handleGlobalKey, true);
  }, []);

  return (
    <>
      <div inert={pauseOpen}>
        <div
          id="canvas-container"
          role={canResume ? 'button' : undefined}
          aria-label={canResume ? 'Resume game controls' : undefined}
          tabIndex={canResume ? 0 : -1}
          onClick={() => spaceUiStore.resumeFromCanvas()}
          onKeyDown={event => {
            if (!canResume || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            if (!event.repeat) spaceUiStore.resumeFromCanvas();
          }}
        />
        <Hud />
        <TextCreationPanel />
        <NavigationPanel />
        <MinimapCanvas />
      </div>
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
      {activeModal === 'agent-build' ? (
        <React.Suspense fallback={<ModalChunkFallback />}><AgentBuildModal /></React.Suspense>
      ) : null}
      {activeModal === 'monitoring' ? (
        <React.Suspense fallback={<ModalChunkFallback />}>
          <AdminMonitoringDashboard isModal onClose={() => spaceUiStore.closeAllModals()} />
        </React.Suspense>
      ) : null}
      <PauseScreen />
    </>
  );
}
