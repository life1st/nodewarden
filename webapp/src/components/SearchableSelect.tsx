import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Check, ChevronDown } from 'lucide-preact';
import { t } from '@/lib/i18n';

export interface SearchableSelectOption {
  value: string;
  label: string;
  pinned?: boolean;
  disabled?: boolean;
}

interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_GAP = 6;
const MENU_PADDING = 8;
const MENU_MAX_HEIGHT = 264;
const MENU_MIN_HEIGHT = 96;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export default function SearchableSelect(props: SearchableSelectProps) {
  const generatedId = useId();
  const controlId = props.id || `searchable-select-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const listboxId = `${controlId}-listbox`;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  const selectedOption = useMemo(
    () => props.options.find((option) => option.value === props.value),
    [props.options, props.value]
  );
  const displayLabel = selectedOption?.label || '';
  const displayLabelNormalized = normalized(displayLabel);

  const effectiveQuery = composing ? '' : query;
  const normalizedQuery = normalized(effectiveQuery);
  const showAllOptions = !normalizedQuery || normalizedQuery === displayLabelNormalized;

  const visibleOptions = useMemo(() => {
    const pinnedOptions = props.options.filter((option) => option.pinned);
    const regularOptions = props.options.filter((option) => !option.pinned);
    if (showAllOptions) return [...pinnedOptions, ...regularOptions];
    return [
      ...pinnedOptions,
      ...regularOptions.filter((option) => normalized(option.label).includes(normalizedQuery)),
    ];
  }, [props.options, showAllOptions, normalizedQuery]);

  const updatePosition = useCallback(() => {
    const input = inputRef.current;
    if (!input || typeof window === 'undefined') return;
    const rect = input.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(0, Math.min(rect.width, viewportWidth - MENU_PADDING * 2));
    const left = Math.max(MENU_PADDING, Math.min(rect.left, viewportWidth - width - MENU_PADDING));
    const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - MENU_PADDING;
    const spaceAbove = rect.top - MENU_GAP - MENU_PADDING;
    const openUp = spaceBelow < Math.min(MENU_MAX_HEIGHT, 180) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      MENU_MIN_HEIGHT,
      Math.min(MENU_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow)
    );
    const top = openUp
      ? Math.max(MENU_PADDING, rect.top - MENU_GAP - maxHeight)
      : Math.min(rect.bottom + MENU_GAP, viewportHeight - MENU_PADDING - maxHeight);
    setMenuPosition({ top, left, width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleViewportChange = () => updatePosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) => {
      const node = target as Node | null;
      return !!node && (!!wrapperRef.current?.contains(node) || !!menuRef.current?.contains(node));
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (isInside(event.target)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (isInside(event.target)) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (composing || showAllOptions) {
      setActiveIndex(visibleOptions.findIndex((option) => option.value === props.value));
      return;
    }
    setActiveIndex(visibleOptions.findIndex((option) => !option.pinned && !option.disabled));
  }, [open, composing, showAllOptions, visibleOptions, props.value]);

  const openList = () => {
    if (props.disabled) return;
    setOpen(true);
    setQuery(displayLabel);
    setActiveIndex(props.options.findIndex((option) => option.value === props.value));
  };

  const closeList = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const selectOption = (option: SearchableSelectOption) => {
    if (option.disabled) return;
    props.onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(-1);
  };

  const moveActive = (delta: number) => {
    if (!visibleOptions.length) return;
    let next = activeIndex;
    if (next < 0) next = delta > 0 ? -1 : 0;
    for (let step = 0; step < visibleOptions.length; step += 1) {
      next = (next + delta + visibleOptions.length) % visibleOptions.length;
      if (visibleOptions[next]?.disabled) continue;
      setActiveIndex(next);
      requestAnimationFrame(() => {
        const node = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${next}"]`);
        node?.scrollIntoView({ block: 'nearest' });
      });
      return;
    }
  };

  const activeDescendant = open && activeIndex >= 0
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className={`searchable-select ${props.className || ''}`} ref={wrapperRef}>
      <input
        ref={inputRef}
        id={controlId}
        className="input searchable-select-input"
        type="text"
        role="combobox"
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendant}
        value={open ? query : displayLabel}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoComplete="off"
        spellcheck={false}
        onFocus={(event) => {
          if (props.disabled || open) return;
          openList();
          const input = event.currentTarget;
          requestAnimationFrame(() => {
            if (document.activeElement === input) input.select();
          });
        }}
        onClick={() => {
          if (props.disabled || open) return;
          openList();
          const input = inputRef.current;
          requestAnimationFrame(() => {
            if (document.activeElement === input) input?.select();
          });
        }}
        onInput={(event) => {
          if (!open) setOpen(true);
          setQuery(event.currentTarget.value);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          setComposing(false);
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.isComposing) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) openList();
            else moveActive(1);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) openList();
            else moveActive(-1);
            return;
          }
          if (event.key === 'Enter') {
            if (!open || activeIndex < 0) return;
            const option = visibleOptions[activeIndex];
            if (!option) return;
            event.preventDefault();
            selectOption(option);
            return;
          }
          if (event.key === 'Escape') {
            if (!open) return;
            event.preventDefault();
            closeList();
            return;
          }
          if (event.key === 'Tab' && open) closeList();
        }}
      />
      <button
        type="button"
        className={`searchable-select-toggle ${open ? 'open' : ''}`}
        tabIndex={-1}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            closeList();
            return;
          }
          openList();
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          });
        }}
      >
        <ChevronDown size={16} />
      </button>
      {open && menuPosition && typeof document !== 'undefined' && createPortal((
        <div
          ref={menuRef}
          id={listboxId}
          className="searchable-select-menu"
          role="listbox"
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            width: `${menuPosition.width}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
          }}
        >
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                aria-disabled={option.disabled || undefined}
                data-option-index={index}
                className={`searchable-select-option ${index === activeIndex ? 'active' : ''} ${option.value === props.value ? 'selected' : ''}`}
                disabled={option.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => selectOption(option)}
              >
                <span className="searchable-select-option-label">{option.label}</span>
                {option.value === props.value
                  ? <Check size={14} className="searchable-select-check" />
                  : <span className="searchable-select-check-placeholder" />}
              </button>
            ))
          ) : (
            <div className="searchable-select-empty">{props.emptyLabel || t('txt_no_items')}</div>
          )}
        </div>
      ), document.body)}
    </div>
  );
}
