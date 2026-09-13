import React from 'react';
import * as THREE from 'three';
import { CuteCharacter, loadCuteCharacter, type SkinModel } from '../../../engine/render/CuteCharacter.ts';

export function CharacterSkinPreview({ url, model }: { url: string; model: SkinModel }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let character: CuteCharacter | null = null;
    let renderer: THREE.WebGLRenderer;
    setFailed(false);
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(240, 240, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 1.2, 4.5);
    camera.lookAt(0, 0.95, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(2, 4, 3);
    scene.add(light);
    void loadCuteCharacter(url, { model, height: 1.8, createBillboard: false, createFirstPersonHand: false, castShadow: false }).then(loaded => {
      if (disposed) { loaded.dispose(); return; }
      character = loaded;
      loaded.object3d.rotation.y = -0.3;
      scene.add(loaded.object3d);
      renderer.render(scene, camera);
    }).catch(() => { if (!disposed) setFailed(true); });
    let dragX: number | null = null;
    const down = (event: PointerEvent) => { dragX = event.clientX; canvas.setPointerCapture(event.pointerId); };
    const move = (event: PointerEvent) => {
      if (dragX === null || !character) return;
      character.object3d.rotation.y += (event.clientX - dragX) * 0.015;
      dragX = event.clientX;
      renderer.render(scene, camera);
    };
    const up = () => { dragX = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    return () => {
      disposed = true;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      character?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [url, model]);
  return <div className="settings-skin-preview">
    <canvas ref={canvasRef} hidden={failed} aria-label="Current character skin. Drag to rotate." />
    {failed ? <img src={url} alt="Current skin texture" /> : <span className="settings-desc">Drag to rotate</span>}
  </div>;
}
