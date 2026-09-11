interface SegmentedFieldProps<T extends string> {
  disabled?: boolean;
  label: string;
  name: string;
  onChange(value: T): void;
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}

/** Render a labelled radio-button segment group. */
export function SegmentedField<T extends string>({
  disabled = false,
  label,
  name,
  onChange,
  options,
  value,
}: SegmentedFieldProps<T>) {
  return (
    <fieldset className="settings-field">
      <legend>{label}</legend>
      <div className="settings-segments">
        {options.map((option) => (
          <label key={option.value}>
            <input
              checked={value === option.value}
              disabled={disabled}
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface ToggleFieldProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
}

/** Render a labelled binary Settings control. */
export function ToggleField({
  checked,
  disabled = false,
  label,
  onChange,
}: ToggleFieldProps) {
  return (
    <label className="settings-field settings-toggle">
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
  );
}
