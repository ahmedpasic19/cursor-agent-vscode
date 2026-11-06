import { forwardRef, useCallback, useMemo, type KeyboardEvent } from 'react';
import type { ModelOption } from '../../../src/shared/protocol';
import {
  EFFORT_LABEL,
  EFFORTS,
  effortOf,
  modelForEffort,
  parseModelId,
  rememberEffort,
  type Effort,
} from '../effort';

interface Props {
  models: ModelOption[];
  /** Current full id; undefined = CLI default — meter disabled */
  model?: string;
  onChange(model: string): void;
}

/**
 * Claude Code's effort slider: a five-step track (Low → Max) with a filled lead-in and a knob on
 * the current step. Only the track is clickable — the "Effort (…)" label is inert, so a click on
 * the text never changes the level.
 */
export const EffortMeter = forwardRef<HTMLDivElement, Props>(function EffortMeter({ models, model, onChange }, ref) {
  const parsed = model ? parseModelId(model) : undefined;
  const tokensLen = useMemo(() => {
    if (!parsed || !model) return 0;
    return (
      models.filter((m) => {
        const p = parseModelId(m.id);
        return p.family === parsed.family && p.fast === parsed.fast && p.token !== undefined;
      }).length
    );
  }, [models, model, parsed]);

  const disabled = !model || !parsed?.token || tokensLen <= 1;
  const current = effortOf(models, model);
  const shownStep = disabled ? 'medium' : current ?? 'medium';
  const labelText = disabled ? '—' : EFFORT_LABEL[shownStep];
  const currentIdx = EFFORTS.indexOf(shownStep);

  const pick = useCallback(
    (e: Effort) => {
      if (disabled || !model) return;
      const next = modelForEffort(models, model, e);
      if (next) {
        rememberEffort(e);
        onChange(next);
      }
    },
    [disabled, model, models, onChange],
  );

  const onKeyDown = (ev: KeyboardEvent) => {
    if (disabled || !model) return;
    const idx = currentIdx;
    if (ev.key === 'ArrowLeft' && idx > 0) {
      ev.preventDefault();
      ev.stopPropagation();
      pick(EFFORTS[idx - 1]!);
    } else if (ev.key === 'ArrowRight' && idx < EFFORTS.length - 1) {
      ev.preventDefault();
      ev.stopPropagation();
      pick(EFFORTS[idx + 1]!);
    }
  };

  const tooltip = disabled
    ? !model
      ? 'Default model: effort is controlled by the CLI default'
      : tokensLen <= 1
        ? 'This model has one effort level'
        : 'Effort not available for this model'
    : undefined;

  const ariaNow = disabled ? 0 : currentIdx + 1;

  return (
    <div
      ref={ref}
      className={`effort-row${disabled ? ' disabled' : ''}`}
      title={tooltip}
      role="slider"
      aria-disabled={disabled}
      aria-label="Effort"
      aria-valuemin={1}
      aria-valuemax={EFFORTS.length}
      aria-valuenow={ariaNow}
      aria-valuetext={labelText}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
    >
      <span className="effort-label" aria-hidden>
        Effort <span className="effort-value">({labelText})</span>
      </span>
      <div className="effort-track" role="presentation">
        {EFFORTS.map((step, i) => {
          const state = disabled ? 'rest' : i < currentIdx ? 'fill' : i === currentIdx ? 'knob' : 'rest';
          return (
            <button
              key={step}
              type="button"
              className={`effort-step is-${state}${i === 0 ? ' is-first' : ''}`}
              aria-label={`${EFFORT_LABEL[step]} effort`}
              aria-current={state === 'knob' || undefined}
              disabled={disabled}
              onClick={() => pick(step)}
              onMouseDown={(e) => e.preventDefault()}
            />
          );
        })}
      </div>
    </div>
  );
});
