import type { ChangeEvent, RefObject } from "react";
import { Download, RotateCcw, Upload } from "lucide-react";
import {
  PICKUP_CLASS_SYMBOLS,
  type BlissHackProfileV1,
  type InterfaceSettingsV1,
  type NetHackSettingsV1,
  type NumberPadMode,
  type PickupClassSymbol,
} from "../../settings/profile";
import { SegmentedField, ToggleField } from "./SettingsControls";

interface SettingsSectionProps {
  draft: BlissHackProfileV1;
  onInterfaceChange(patch: Partial<InterfaceSettingsV1>): void;
  onNetHackChange(patch: Partial<NetHackSettingsV1>): void;
}

const PICKUP_CLASSES: ReadonlyArray<{
  label: string;
  symbol: PickupClassSymbol;
}> = [
  { symbol: "$", label: "Coins" },
  { symbol: "\"", label: "Amulets" },
  { symbol: ")", label: "Weapons" },
  { symbol: "[", label: "Armor" },
  { symbol: "%", label: "Food" },
  { symbol: "?", label: "Scrolls" },
  { symbol: "+", label: "Spellbooks" },
  { symbol: "!", label: "Potions" },
  { symbol: "=", label: "Rings" },
  { symbol: "/", label: "Wands" },
  { symbol: "(", label: "Tools" },
  { symbol: "*", label: "Gems" },
  { symbol: "`", label: "Rocks" },
  { symbol: "0", label: "Iron balls" },
  { symbol: "_", label: "Chains" },
];

const NUMBER_PAD_OPTIONS: ReadonlyArray<{
  label: string;
  value: NumberPadMode;
}> = [
  { value: 0, label: "0 — Letter movement" },
  { value: 1, label: "1 — Numeric keypad" },
  { value: 2, label: "2 — Numeric keypad, PC-compatible" },
  { value: 3, label: "3 — Phone keypad layout" },
  { value: 4, label: "4 — Phone layout, PC-compatible" },
  { value: -1, label: "-1 — Letter movement, swap Y and Z" },
];

/** Render display and status-related profile fields. */
export function InterfaceSettingsSection({
  draft,
  onInterfaceChange,
  onNetHackChange,
}: SettingsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="interface-title">
      <header>
        <h2 id="interface-title">Interface</h2>
      </header>
      <div className="settings-fields">
        <SegmentedField
          label="Terminal font size"
          name="terminal-font-size"
          onChange={(terminalFontSize) => {
            onInterfaceChange({ terminalFontSize });
          }}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
          value={draft.interface.terminalFontSize}
        />
        <SegmentedField
          label="Message history"
          name="message-history"
          onChange={(value) => {
            onInterfaceChange({
              messageHistoryLines: Number(value) as 3 | 5,
            });
          }}
          options={[
            { value: "3", label: "3 lines" },
            { value: "5", label: "5 lines" },
          ]}
          value={String(draft.interface.messageHistoryLines)}
        />
        <ToggleField
          checked={draft.interface.followPlayer}
          label="Follow player on the map"
          onChange={(followPlayer) => {
            onInterfaceChange({ followPlayer });
          }}
        />
        <fieldset className="settings-field settings-subsection">
          <legend>Status display</legend>
          <div className="settings-toggle-grid">
            <ToggleField
              checked={draft.nethack.showExperience}
              label="Show experience"
              onChange={(showExperience) => {
                onNetHackChange({ showExperience });
              }}
            />
            <ToggleField
              checked={draft.nethack.showTime}
              label="Show turn count"
              onChange={(showTime) => {
                onNetHackChange({ showTime });
              }}
            />
          </div>
        </fieldset>
      </div>
    </section>
  );
}

/** Render pickup, sorting, and permanent inventory profile fields. */
export function InventorySettingsSection({
  draft,
  onInterfaceChange,
  onNetHackChange,
}: SettingsSectionProps) {
  const pickupTypes = draft.nethack.pickupTypes;
  return (
    <section className="settings-section" aria-labelledby="inventory-title">
      <header>
        <h2 id="inventory-title">Inventory</h2>
      </header>
      <div className="settings-fields">
        <ToggleField
          checked={draft.nethack.autopickup}
          label="Automatic pickup"
          onChange={(autopickup) => onNetHackChange({ autopickup })}
        />
        <fieldset className="settings-field settings-pickup">
          <legend>Pickup categories</legend>
          <div className="settings-segments settings-segments-compact">
            {(["all", "selected"] as const).map((mode) => (
              <label key={mode}>
                <input
                  checked={pickupTypes.mode === mode}
                  name="pickup-mode"
                  onChange={() => {
                    onNetHackChange({
                      pickupTypes: mode === "all"
                        ? { mode: "all" }
                        : {
                          mode: "selected",
                          classes: [...PICKUP_CLASS_SYMBOLS],
                        },
                    });
                  }}
                  type="radio"
                  value={mode}
                />
                <span>{mode === "all" ? "All" : "Selected"}</span>
              </label>
            ))}
          </div>
          {pickupTypes.mode === "selected" && (
            <div className="settings-pickup-grid">
              {PICKUP_CLASSES.map(({ symbol, label }) => {
                const selected = pickupTypes.classes;
                const checked = selected.includes(symbol);
                return (
                  <label key={symbol}>
                    <input
                      checked={checked}
                      disabled={checked && selected.length === 1}
                      onChange={(event) => {
                        const selectedSet = new Set(selected);
                        if (event.currentTarget.checked) {
                          selectedSet.add(symbol);
                        } else {
                          selectedSet.delete(symbol);
                        }
                        onNetHackChange({
                          pickupTypes: {
                            mode: "selected",
                            classes: PICKUP_CLASS_SYMBOLS.filter(
                              (candidate) => selectedSet.has(candidate),
                            ),
                          },
                        });
                      }}
                      type="checkbox"
                    />
                    <code>{symbol}</code>
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <ToggleField
          checked={draft.nethack.sortpack}
          label="Sort inventory"
          onChange={(sortpack) => onNetHackChange({ sortpack })}
        />
        <fieldset className="settings-field settings-subsection">
          <legend>Permanent Inventory</legend>
          <ToggleField
            checked={draft.nethack.permInvent}
            label="Enable Permanent Inventory"
            onChange={(permInvent) => {
              onNetHackChange({ permInvent });
            }}
          />
          <div
            className={`settings-dependent-fields${
              draft.nethack.permInvent ? "" : " settings-fields-disabled"
            }`}
          >
            <label className="settings-field settings-select">
              <span>Contents</span>
              <select
                disabled={!draft.nethack.permInvent}
                onChange={(event) => {
                  onNetHackChange({
                    perminvMode: event.currentTarget.value as
                      NetHackSettingsV1["perminvMode"],
                  });
                }}
                value={draft.nethack.perminvMode}
              >
                <option value="all">All except gold</option>
                <option value="full">Full including gold</option>
                <option value="in-use">Items in use</option>
              </select>
            </label>
            <SegmentedField
              disabled={!draft.nethack.permInvent}
              label="Preferred position"
              name="inventory-position"
              onChange={(permanentInventoryPosition) => {
                onInterfaceChange({ permanentInventoryPosition });
              }}
              options={[
                { value: "right", label: "Right" },
                { value: "below", label: "Below" },
              ]}
              value={draft.interface.permanentInventoryPosition}
            />
            <ToggleField
              checked={draft.interface.permanentInventoryCollapsed}
              disabled={!draft.nethack.permInvent}
              label="Start collapsed"
              onChange={(permanentInventoryCollapsed) => {
                onInterfaceChange({ permanentInventoryCollapsed });
              }}
            />
          </div>
        </fieldset>
      </div>
    </section>
  );
}

interface NetHackSettingsSectionProps extends SettingsSectionProps {
  isGameSettings: boolean;
}

/** Render NetHack runtime and new-game default fields. */
export function NetHackSettingsSection({
  draft,
  isGameSettings,
  onNetHackChange,
}: NetHackSettingsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="nethack-title">
      <header>
        <h2 id="nethack-title">NetHack</h2>
        <span>
          {isGameSettings ? "Current game and future defaults" : "New-game defaults"}
        </span>
      </header>
      <div className="settings-fields">
        <ToggleField
          checked={draft.nethack.tutorial}
          label="Offer tutorial for new games"
          onChange={(tutorial) => onNetHackChange({ tutorial })}
        />
        <label className="settings-field settings-select">
          <span>Movement keys</span>
          <select
            onChange={(event) => {
              onNetHackChange({
                numberPad: Number(event.currentTarget.value) as NumberPadMode,
              });
            }}
            value={draft.nethack.numberPad}
          >
            {NUMBER_PAD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <ToggleField
          checked={draft.nethack.safePet}
          label="Protect peaceful pets"
          onChange={(safePet) => onNetHackChange({ safePet })}
        />
      </div>
    </section>
  );
}

interface ProfileSettingsSectionProps {
  exportError: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  importButtonRef: RefObject<HTMLButtonElement | null>;
  importError: boolean;
  onExport(): void;
  onImport(event: ChangeEvent<HTMLInputElement>): void;
  onRestore(trigger: HTMLButtonElement): void;
  pending: boolean;
  storageAvailable: boolean;
}

/** Render profile transfer and default-restoration actions. */
export function ProfileSettingsSection({
  exportError,
  fileInputRef,
  importButtonRef,
  importError,
  onExport,
  onImport,
  onRestore,
  pending,
  storageAvailable,
}: ProfileSettingsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="profile-title">
      <header>
        <h2 id="profile-title">Profile</h2>
      </header>
      <div className="settings-profile-actions">
        <button
          aria-describedby={exportError ? "settings-error" : undefined}
          disabled={pending}
          onClick={onExport}
          type="button"
        >
          <Download aria-hidden="true" size={17} />
          Export Profile
        </button>
        <button
          aria-describedby={importError ? "settings-error" : undefined}
          disabled={!storageAvailable || pending}
          onClick={() => fileInputRef.current?.click()}
          ref={importButtonRef}
          type="button"
        >
          <Upload aria-hidden="true" size={17} />
          Import Profile
        </button>
        <input
          accept=".bhprofile,application/json"
          aria-describedby={importError ? "settings-error" : undefined}
          aria-invalid={importError || undefined}
          aria-label="Import profile file"
          className="settings-file-input"
          disabled={!storageAvailable}
          onChange={onImport}
          ref={fileInputRef}
          type="file"
        />
        <button
          disabled={!storageAvailable || pending}
          onClick={(event) => onRestore(event.currentTarget)}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={17} />
          Restore Defaults
        </button>
      </div>
    </section>
  );
}
