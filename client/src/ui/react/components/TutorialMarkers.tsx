import React, { useEffect, useRef } from 'react';
import { Vector3 } from 'three';
import { bendPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { SpecialTool } from '../../../engine/controls/ControlBindings.ts';
import { nearbyTutorialSelectionChapter, tutorialSelectionMarkers } from '../../../tutorial/TutorialSelectionMarkers.ts';
import { useSpaceUiFields } from '../store/useSpaceUi.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';

export function TutorialMarkers() {
  const { controller, world, sceneRenderer, hasStarted, activeModal, apiDocsOpen } = useSpaceUiFields(
    'controller', 'world', 'sceneRenderer', 'hasStarted', 'activeModal', 'apiDocsOpen');
  const root = useRef<HTMLDivElement>(null);
  const hidden = !hasStarted || !!activeModal || apiDocsOpen;
  useEffect(() => {
    if (hidden || !controller || !world || !sceneRenderer) return;
    const point = new Vector3();
    return sceneRenderer.subscribeWorldOverlay(camera => {
      const elements = root.current?.children;
      if (!elements) return;
      const state = spaceUiStore.getSnapshot();
      const enabled = controller.activeTool === SpecialTool.SELECTOR && !state.entityContextMenu && !state.selectorContextMenu;
      const player = controller.physics.position;
      const chapter = nearbyTutorialSelectionChapter(player);
      tutorialSelectionMarkers.forEach((marker, index) => {
        const element = elements[index] as HTMLElement;
        // Assembly removes the authored cells, so their labels disappear too.
        const subject = marker.subject;
        let visible = enabled && marker.chapter === chapter && world.microVoxels.get(marker.x * 8, marker.y * 8, marker.z * 8) === marker.color
          && world.microVoxels.has(subject.x * 8, subject.y * 8, subject.z * 8);
        if (visible) {
          bendPoint(marker.x + .0625, marker.y + .0625, marker.z + .0625, point);
          point.project(camera);
          visible = [point.x, point.y, point.z].every(Number.isFinite)
            && point.z >= -1 && point.z <= 1 && Math.abs(point.x) < .95 && Math.abs(point.y) < .9;
        }
        element.hidden = !visible;
        if (visible) {
          element.style.left = `${(point.x + 1) * window.innerWidth / 2}px`;
          element.style.top = `${(1 - point.y) * window.innerHeight / 2}px`;
        }
      });
    });
  }, [controller, world, sceneRenderer, hidden]);
  if (hidden) return null;
  return <div ref={root} className="tutorial-selection-markers" aria-label="Tutorial selection points">
    {tutorialSelectionMarkers.map(marker => <div key={`${marker.chapter}-${marker.label}`} hidden
      className="tutorial-selection-marker" style={{ color: `#${marker.color.toString(16).padStart(6, '0')}` }}>
      <span>{marker.label}</span>
    </div>)}
  </div>;
}
