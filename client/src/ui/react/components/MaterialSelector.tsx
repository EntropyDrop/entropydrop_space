import React, { useState } from 'react';
import {
  VoxelMaterialIds,
  emissiveVoxelMaterialId,
  isEmissiveVoxelMaterial,
  isTranslucentVoxelMaterial,
  voxelMaterialEmission,
  voxelMaterialTransparency,
} from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

type MaterialSelectorProps = {
  materialId: number;
  onChange: (materialId: number) => void;
};

export function MaterialSelector({ materialId, onChange }: MaterialSelectorProps) {
  // Zero transparency or zero glow uses the default ID, without hiding the active slider.
  const [editingZeroMode, setEditingZeroMode] = useState<'none' | 'transparent' | 'emissive'>('none');
  const transparent = isTranslucentVoxelMaterial(materialId)
    || (materialId === VoxelMaterialIds.DEFAULT && editingZeroMode === 'transparent');
  const emissive = isEmissiveVoxelMaterial(materialId)
    || (materialId === VoxelMaterialIds.DEFAULT && editingZeroMode === 'emissive');
  const transparency = voxelMaterialTransparency(materialId);
  const emission = voxelMaterialEmission(materialId);

  const changeTransparency = (value: number) => {
    if (!Number.isFinite(value)) return;
    const percentage = Math.round(Math.max(0, Math.min(100, value)));
    setEditingZeroMode(percentage === 0 ? 'transparent' : 'none');
    onChange(percentage === 0 ? VoxelMaterialIds.DEFAULT : percentage + 1);
  };

  const changeEmission = (value: number) => {
    if (!Number.isFinite(value)) return;
    const percentage = Math.round(Math.max(0, Math.min(100, value)));
    setEditingZeroMode(percentage === 0 ? 'emissive' : 'none');
    onChange(emissiveVoxelMaterialId(percentage));
  };

  const chooseDefault = () => {
    setEditingZeroMode('none');
    onChange(VoxelMaterialIds.DEFAULT);
  };

  return (
    <div className="material-selector">
      <span className="material-selector-label">Material</span>
      <div className="material-selector-types" role="group" aria-label="Material type">
        <button type="button" aria-pressed={!transparent && !emissive && materialId === VoxelMaterialIds.DEFAULT}
          onClick={chooseDefault}>Default</button>
        <button type="button" aria-pressed={emissive} onClick={() => {
          if (!emissive) {
            setEditingZeroMode('none');
            onChange(VoxelMaterialIds.EMISSIVE);
          }
        }}>Emissive</button>
        <button type="button" aria-pressed={transparent} onClick={() => {
          if (!transparent) {
            setEditingZeroMode('none');
            onChange(VoxelMaterialIds.TRANSLUCENT);
          }
        }}>Transparent</button>
      </div>
      {emissive && <div className="material-transparency">
        <label className="material-transparency-value">
          <span>Glow</span>
          <span className="material-transparency-number">
            <input type="number" min={0} max={100} step={1} value={emission}
              aria-label="Glow percentage"
              onChange={event => changeEmission(event.currentTarget.valueAsNumber)} />
            <span aria-hidden="true">%</span>
          </span>
        </label>
        <input className="material-transparency-slider" type="range" min={0} max={100} step={1}
          aria-label="Glow" aria-valuetext={`${emission}%`}
          value={emission} onChange={event => changeEmission(event.currentTarget.valueAsNumber)} />
        <div className="material-transparency-scale" aria-hidden="true">
          {[0, 25, 50, 75, 100].map(value => <span key={value}>{value}</span>)}
        </div>
      </div>}
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
