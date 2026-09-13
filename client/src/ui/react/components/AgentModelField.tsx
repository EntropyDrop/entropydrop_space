import React, { useEffect, useRef, useState } from 'react';
import { fetchAgentModels, isLocalDevelopmentHost } from '../../../engine/contraption/AgentChat.ts';

interface AgentModelFieldProps {
  apiKey?: string;
  baseUrl?: string;
  className?: string;
  inputId: string;
  label?: React.ReactNode;
  labelClassName?: string;
  model?: string;
  onModelChange: (model: string) => void;
}

function canAutoLoad(baseUrl: string, apiKey: string): boolean {
  if (apiKey.trim()) return true;
  try {
    const hostname = new URL(baseUrl.trim()).hostname;
    return isLocalDevelopmentHost(hostname);
  } catch {
    return false;
  }
}

/** Shared model discovery control for both AI settings panels. */
export function AgentModelField({
  apiKey = '',
  baseUrl = '',
  className = 'agent-config-field',
  inputId,
  label,
  labelClassName = 'config-label',
  model = '',
  onModelChange
}: AgentModelFieldProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  const currentModel = useRef(model);
  const changeModel = useRef(onModelChange);
  const listId = `${inputId}-options`;

  useEffect(() => { currentModel.current = model; }, [model]);
  useEffect(() => { changeModel.current = onModelChange; }, [onModelChange]);

  const loadModels = async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');
    const result: any = await fetchAgentModels({ baseUrl, apiKey });
    if (sequence !== requestSequence.current) return;
    setLoading(false);
    if (!result.ok) {
      setModels([]);
      setError(result.error || 'Unable to load models.');
      return;
    }
    const nextModels = result.models as string[];
    setModels(nextModels);
    const selected = nextModels.includes(currentModel.current)
      ? currentModel.current
      : nextModels[0];
    if (selected !== currentModel.current) changeModel.current(selected);
  };

  useEffect(() => {
    requestSequence.current += 1;
    setModels([]);
    setError('');
    setLoading(false);
    if (!baseUrl.trim() || !canAutoLoad(baseUrl, apiKey)) return undefined;
    const timer = window.setTimeout(() => { void loadModels(); }, 500);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
    };
  }, [baseUrl, apiKey]);

  return (
    <div className={`${className} agent-model-field`}>
      {label || <span className={labelClassName}>Model</span>}
      <div className="agent-model-control">
        <input
          id={inputId}
          className="config-input"
          list={models.length ? listId : undefined}
          value={model}
          placeholder="gpt-4o-mini"
          onChange={event => onModelChange(event.target.value)}
        />
        <button
          type="button"
          tabIndex={-1}
          className="agent-model-refresh"
          disabled={loading || !baseUrl.trim()}
          title="Load models from the configured API base URL"
          onClick={() => void loadModels()}
        >
          {loading ? '…' : '↻ Models'}
        </button>
      </div>
      {models.length ? (
        <datalist id={listId}>{models.map(id => <option key={id} value={id} />)}</datalist>
      ) : null}
      <span className={`agent-model-status ${error ? 'error' : ''}`}>
        {error || (models.length ? `${models.length} model${models.length > 1 ? 's' : ''} loaded` : 'Enter a model or load it from the API')}
      </span>
    </div>
  );
}
