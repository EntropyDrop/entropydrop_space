import React, { useCallback, useEffect, useState } from 'react';
import { LiaAngleDownSolid } from 'react-icons/lia';
import { useSpaceUi } from '../store/useSpaceUi.ts';

export function NavigationPanel() {
  const navigation = useSpaceUi(state => state.navigationSystem);
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [z, setZ] = useState('');
  const [expanded, setExpanded] = useState(false);
  const navigating = !!navigation?.isNavigating;

  useEffect(() => {
    const target = navigation?.target;
    if (!target) return;
    setX(target.x.toFixed(0));
    setY(target.y.toFixed(0));
    setZ(target.z.toFixed(0));
  }, [navigation?.target]);

  useEffect(() => {
    if (navigating) {
      setExpanded(true);
    }
  }, [navigating]);

  useEffect(() => {
    if (!navigating) return;
    const cancelOnInput = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const movementCodes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (movementCodes.includes(event.code)) {
        navigation.stopNavigation('cancelled');
      }
    };
    window.addEventListener('keydown', cancelOnInput, true);
    return () => window.removeEventListener('keydown', cancelOnInput, true);
  }, [navigating, navigation]);

  const start = () => navigation?.startFromInputValues?.(x, y, z);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      start();
      (event.currentTarget as HTMLElement).blur();
    }
  };

  return (
    <div id="nav-system-container" className={`nav-system-container ${navigating ? 'navigating' : ''} ${expanded ? 'expanded' : 'collapsed'}`}>
      <div
        className="nav-header"
        id="nav-header-toggle"
        role="button"
        tabIndex={-1}
        title={expanded ? 'Collapse navigation' : 'Expand navigation'}
        onClick={() => setExpanded(val => !val)}
      >
        <div className="nav-badge">
          <span className={`nav-badge-dot ${navigating ? 'active' : ''}`} />
          <span>NAVIGATION</span>
          {navigating && <span className="nav-status-badge">ACTIVE</span>}
        </div>
        <div className="nav-header-actions">
          {navigating && !expanded && (
            <button
              type="button"
              id="nav-mini-stop-btn"
              tabIndex={-1}
              className="nav-mini-stop-btn"
              title="Stop navigation"
              onClick={(e) => {
                e.stopPropagation();
                navigation?.stopNavigation?.('cancelled');
              }}
            >STOP</button>
          )}
          <button
            type="button"
            id="nav-toggle-btn"
            tabIndex={-1}
            className={`nav-toggle-btn ${expanded ? 'expanded' : ''}`}
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(val => !val);
            }}
          >
            <LiaAngleDownSolid />
          </button>
        </div>
      </div>
      <div className="nav-body" id="nav-body" style={{ display: expanded ? 'flex' : 'none' }}>
        <div className="nav-coord-inputs">
          <div className="nav-input-field"><span className="nav-coord-label">X</span><input type="number" id="nav-input-x" className="nav-number-input" placeholder="0" step="any" value={x} onChange={event => setX(event.target.value)} onKeyDown={handleKeyDown} /></div>
          <div className="nav-input-field"><span className="nav-coord-label">Y</span><input type="number" id="nav-input-y" className="nav-number-input" placeholder="20" step="any" value={y} onChange={event => setY(event.target.value)} onKeyDown={handleKeyDown} /></div>
          <div className="nav-input-field"><span className="nav-coord-label">Z</span><input type="number" id="nav-input-z" className="nav-number-input" placeholder="0" step="any" value={z} onChange={event => setZ(event.target.value)} onKeyDown={handleKeyDown} /></div>
        </div>
        <button
          type="button"
          id="nav-start-btn"
          tabIndex={-1}
          className={`nav-action-btn ${navigating ? 'stop-btn' : 'start-btn'}`}
          onClick={(e) => {
            (e.currentTarget as HTMLElement)?.blur();
            if (navigating) navigation?.stopNavigation?.('cancelled');
            else start();
          }}
        >{navigating ? 'STOP' : 'START'}</button>
      </div>
    </div>
  );
}

export function MinimapCanvas() {
  const minimap = useSpaceUi(state => state.minimap);
  const enabled = useSpaceUi(state => state.minimapEnabled);
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    minimap?.attachCanvas?.(canvas);
  }, [minimap]);
  if (!enabled) return null;
  return (
    <div id="minimap-container" className="minimap-container">
      <canvas ref={attachCanvas} className="minimap-canvas" aria-label="World minimap" />
    </div>
  );
}
