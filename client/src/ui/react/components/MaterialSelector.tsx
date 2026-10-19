import React, { useState } from 'react';
import {
  VoxelMaterialIds,
  isTranslucentVoxelMaterial,
  voxelMaterialTransparency,
} from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

type MaterialSelectorProps = {
  materialId: number;
  onChange: (materialId: number) => void;
};

export function MaterialSelector({ materialId, onChange }: MaterialSelectorProps) {
  // Zero transparency uses the opaque ID, but must not hide the active slider.
  const [editingZeroTransparency, setEditingZeroTransparency] = useState(false);
  const transparent = isTranslucentVoxelMaterial(materialId)
    || (materialId === VoxelMaterialIds.DEFAULT && editingZeroTransparency);
  const transparency = voxelMaterialTransparency(materialId);

  const changeTransparency = (value: number) => {
    if (!Number.isFinite(value)) return;
    const percentage = Math.round(Math.max(0, Math.min(100, value)));
    setEditingZeroTransparency(percentage === 0);
    onChange(percentage === 0 ? VoxelMaterialIds.DEFAULT : percentage + 1);
  };

  const chooseOpaque = (id: number) => {
    setEditingZeroTransparency(false);
    onChange(id);
  };

  return (
    <div className="material-selector">
      <span className="material-selector-label">Material</span>
      <div className="material-selector-types" role="group" aria-label="Material type">
        <button type="button" aria-pressed={!transparent && materialId === VoxelMaterialIds.DEFAULT}
          onClick={() => chooseOpaque(VoxelMaterialIds.DEFAULT)}>Default</button>
        <button type="button" aria-pressed={materialId === VoxelMaterialIds.EMISSIVE}
          onClick={() => chooseOpaque(VoxelMaterialIds.EMISSIVE)}>Emissive</button>
        <button type="button" aria-pressed={transparent} onClick={() => {
          if (!transparent) {
            setEditingZeroTransparency(false);
            onChange(VoxelMaterialIds.TRANSLUCENT);
          }
        }}>Transparent</button>
      </div>
      {transparent && <div className="material-transparency">
        <label className="material-transparency-value">
          <span>Transparency</span>
          <span className="material-transparency-number">
            <input type="number" min={0} max={100} step={1} value={transparency}
              aria-label="Transparency percentage"
              onChange={event => changeTransparency(event.currentTarget.valueAsNumber)} />
            <span aria-hidden="true">%</span>
          </span>
        </label>
        <input className="material-transparency-slider" type="range" min={0} max={100} step={1}
          aria-label="Transparency" aria-valuetext={`${transparency}%`}
          value={transparency} onChange={event => changeTransparency(event.currentTarget.valueAsNumber)} />
        <div className="material-transparency-scale" aria-hidden="true">
          {[0, 25, 50, 75, 100].map(value => <span key={value}>{value}</span>)}
        </div>
      </div>}
    </div>
  );
}
