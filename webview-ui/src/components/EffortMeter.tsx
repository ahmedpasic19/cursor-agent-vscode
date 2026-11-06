import { forwardRef, useCallback, useMemo, type KeyboardEvent } from 'react';
import type { ModelOption } from '../../../src/shared/protocol';
import {
  EFFORTS,
  effortOf,
  modelForEffort,
  parseModelId,
  rememberEffort,
  type Effort,
} from '../effort';
import { EffortIcon } from '../sessions/icons';

interface Props {
  models: ModelOption[];
  /** Current full id; undefined = CLI default — meter disabled */
  model?: string;
  onChange(model: string): void;
}

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

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
    const idx = EFFORTS.indexOf(shownStep);
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

  const ariaNow = disabled ? 0 : EFFORTS.indexOf(shownStep) + 1;

  return (
    <div
      ref={ref}
      className={`effort-row${disabled ? ' disabled' : ''}`}
      title={tooltip}
      role="slider"
      aria-disabled={disabled}
      aria-valuemin={1}
      aria-valuemax={4}
      aria-valuenow={ariaNow}
      aria-valuetext={labelText}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
    >
      <span className="effort-label">
        <span className="effort-icon-wrap" aria-hidden>
          <EffortIcon />
        </span>
        Effort ({labelText})
      </span>
      <div className="effort-track" role="presentation">
        {EFFORTS.map((step) => {
          const on = !disabled && step === shownStep;
          return (
            <button
              key={step}
              type="button"
              className={`effort-dot${on ? ' on' : ''}`}
              aria-label={`${EFFORT_LABEL[step]} effort`}
              aria-current={on || undefined}
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
