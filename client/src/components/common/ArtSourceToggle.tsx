import { ToggleButtonGroup, type ToggleButtonGroupProps } from './ToggleButtonGroup';

export type ArtSource = 'scryfall' | 'mpc' | 'cardsmith' | 'cardbuilder' | 'mythicblackcore';

const ALL_ART_SOURCE_OPTIONS = [
    { id: 'scryfall' as const, label: 'Scryfall', highlightColor: '#431e3f' },
    { id: 'mpc' as const, label: 'MPC Autofill', highlightColor: 'rgb(76, 155, 232)' },
    { id: 'cardsmith' as const, label: 'Cardsmith', highlightColor: '#e65100' },
    { id: 'cardbuilder' as const, label: 'Card Builder', highlightColor: '#00695c' },
    { id: 'mythicblackcore' as const, label: 'MBC', highlightColor: '#1a1a2e' },
];

const PREFERRED_ART_SOURCE_OPTIONS = [
    { id: 'scryfall' as const, label: 'Scryfall', highlightColor: '#431e3f' },
    { id: 'mpc' as const, label: 'MPC Autofill', highlightColor: 'rgb(76, 155, 232)' },
];

type ArtSourceToggleProps = {
    value: ArtSource;
    onChange: (value: ArtSource) => void;
    /** When true, reverses option order (useful for vertical mode where sideways-lr reads bottom-to-top) */
    reversed?: boolean;
    /** When true, only show scryfall/mpc options (for settings/preference pickers) */
    preferredOnly?: boolean;
} & Omit<ToggleButtonGroupProps<ArtSource>, 'options' | 'value' | 'onChange'>;

/**
 * A styled toggle button for switching between art sources.
 * Wraps ToggleButtonGroup with consistent branding colors.
 *
 * Use `reversed` prop for vertical landscape layouts where sideways-lr reads bottom-to-top.
 * Use `preferredOnly` prop for settings that only need scryfall/mpc toggle.
 */
export function ArtSourceToggle({
    value,
    onChange,
    reversed = false,
    preferredOnly = false,
    ...rest
}: ArtSourceToggleProps) {
    const options = preferredOnly ? PREFERRED_ART_SOURCE_OPTIONS : ALL_ART_SOURCE_OPTIONS;
    const orderedOptions = reversed ? [...options].reverse() : options;

    return (
        <ToggleButtonGroup
            options={orderedOptions}
            value={value}
            onChange={onChange}
            {...rest}
        />
    );
}
