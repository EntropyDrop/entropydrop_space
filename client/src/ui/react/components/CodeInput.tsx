import React, { useLayoutEffect, useRef, useState } from 'react';
import { applyCodeCompletion, getCodeCompletions, type CodeCompletionQuery } from '../utils/codeCompletion.ts';

function popupPosition(input: HTMLTextAreaElement) {
  const host = input.parentElement!;
  const mirror = document.createElement('div');
  const style = getComputedStyle(input);
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'tabSize'] as const) {
    mirror.style[property] = style[property];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none', top: '0', left: '0' });
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  host.appendChild(mirror);
  const x = input.offsetLeft + marker.offsetLeft - input.scrollLeft;
  const y = input.offsetTop + marker.offsetTop - input.scrollTop;
  mirror.remove();
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const below = Math.max(0, host.clientHeight - y - lineHeight - 8);
  const above = Math.max(0, y - 8);
  const upwards = below < 240 && above > below;
  return {
    left: Math.max(8, Math.min(x, host.clientWidth - 408)),
    top: Math.max(8, Math.min(upwards ? y : y + lineHeight, host.clientHeight - 24)),
    maxHeight: Math.max(80, Math.min(360, upwards ? above : below)),
    upwards,
  };
}

interface CompletionMenu {
  query: CodeCompletionQuery;
  source: string;
  caret: number;
  position: ReturnType<typeof popupPosition>;
  active: number;
}

export function CodeInput({ value, placeholder, onChange }: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const inserting = useRef(false);
  const pendingSelection = useRef<{ source: string; caret: number } | null>(null);
  const [menu, setMenu] = useState<CompletionMenu | null>(null);
  const visibleMenu = menu?.source === value ? menu : null;
  const selected = visibleMenu?.query.items[visibleMenu.active];

  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (pending?.source === value) {
      inputRef.current?.setSelectionRange(pending.caret, pending.caret);
      pendingSelection.current = null;
    }
  }, [value]);

  useLayoutEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [visibleMenu?.active, visibleMenu?.query]);

  function refresh(input: HTMLTextAreaElement, explicit = false) {
    if (composing.current || input.selectionStart !== input.selectionEnd) { setMenu(null); return; }
    const query = getCodeCompletions(input.value, input.selectionStart, explicit);
    setMenu(query ? { query, source: input.value, caret: input.selectionStart, position: popupPosition(input), active: 0 } : null);
  }

  function accept(index: number) {
    const input = inputRef.current;
    if (!input || !visibleMenu || input.value !== visibleMenu.source) return;
    const item = visibleMenu.query.items[index];
    if (!item) return;
    const edit = applyCodeCompletion(input.value, visibleMenu.query, item);
    pendingSelection.current = { source: edit.source, caret: edit.selection };
    input.focus();
    input.setSelectionRange(edit.from, edit.to);
    inserting.current = true;
    try {
      // Native insertion keeps completion in the textarea's normal undo history.
      if (!document.execCommand('insertText', false, edit.text)) input.setRangeText(edit.text, edit.from, edit.to, 'end');
    } finally { inserting.current = false; }
    onChange(edit.source);
    input.setSelectionRange(edit.selection, edit.selection);
    setMenu(null);
  }

  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      refresh(event.currentTarget, true);
      return;
    }
    if (!visibleMenu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setMenu({ ...visibleMenu, active: (visibleMenu.active + direction + visibleMenu.query.items.length) % visibleMenu.query.items.length });
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        accept(visibleMenu.active);
      }
    }
  }

  return <div className="code-editor-main">
    <div className="code-gutter" id="code-gutter" />
    <textarea id="script-textarea" ref={inputRef} className="code-textarea" spellCheck={false}
      autoCapitalize="off" autoCorrect="off" aria-label="Component code"
      data-code-completions-open={visibleMenu ? 'true' : undefined}
      aria-autocomplete="list" aria-controls={visibleMenu ? 'code-completions' : undefined}
      aria-expanded={!!visibleMenu} aria-activedescendant={selected ? `code-completion-${visibleMenu!.active}` : undefined}
      placeholder={placeholder} value={value} onKeyDown={keyDown}
      onChange={event => {
        if (inserting.current) return;
        onChange(event.target.value);
        refresh(event.target);
      }}
      onSelect={event => {
        const input = event.currentTarget;
        if (visibleMenu && !inserting.current && !pendingSelection.current
          && (input.selectionStart !== visibleMenu.caret || input.selectionEnd !== visibleMenu.caret)) refresh(input);
      }}
      onScroll={event => {
        if (visibleMenu) setMenu({ ...visibleMenu, position: popupPosition(event.currentTarget) });
      }}
      onBlur={() => setMenu(null)} onCompositionStart={() => { composing.current = true; setMenu(null); }}
      onCompositionEnd={event => { composing.current = false; refresh(event.currentTarget); }}
    />
    {visibleMenu && selected ? <div className="code-completion-popup" style={{
      left: visibleMenu.position.left, top: visibleMenu.position.top,
      maxHeight: visibleMenu.position.maxHeight, transform: visibleMenu.position.upwards ? 'translateY(-100%)' : undefined,
    }}>
      <div id="code-completions" className="code-completion-list" role="listbox" aria-label="Code completions">
        {visibleMenu.query.items.map((item, index) => <button key={item.label} id={`code-completion-${index}`}
          type="button" tabIndex={-1} role="option" aria-selected={index === visibleMenu.active}
          ref={index === visibleMenu.active ? activeOption : undefined}
          className={`code-completion-option ${index === visibleMenu.active ? 'active' : ''}`}
          onMouseDown={event => event.preventDefault()} onClick={() => accept(index)}>
          <span className="code-completion-kind">{item.kind === 'method' ? 'ƒ' : item.kind === 'property' ? '·' : 'a'}</span>
          <span className="code-completion-name">{item.label}</span><span className="code-completion-type">{item.kind}</span>
        </button>)}
      </div>
      <div className="code-completion-details"><code>{selected.signature}</code><p>{selected.description}</p></div>
      <div className="code-completion-keys">↑↓ select · Tab / Enter insert · Esc close</div>
    </div> : null}
  </div>;
}
