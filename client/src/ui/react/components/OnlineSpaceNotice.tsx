import React from 'react';
import { onlineSpaceUrl, ONLINE_SPACE_FEATURES, type OnlineSpaceFeature } from '../../../bootstrap/SpaceSiteLinks.ts';

export function OnlineSpaceNotice({ feature, compact = false }: { feature: OnlineSpaceFeature; compact?: boolean }) {
  const { title, description, panel, action } = ONLINE_SPACE_FEATURES[feature];
  return (
    <section className={`offline-online-notice${compact ? ' compact' : ''}`}>
      <h3>{title}</h3>
      <p>{description}</p>
      <p className="settings-desc">Your offline world stays saved in this browser. Online worlds have separate saves.</p>
      <a className="small-btn primary" href={onlineSpaceUrl(panel)}
        target="_blank" rel="noopener noreferrer">{action} ↗</a>
    </section>
  );
}
