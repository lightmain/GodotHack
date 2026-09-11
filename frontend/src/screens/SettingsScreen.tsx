import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Download,
  RotateCcw,
  Upload,
} from "lucide-react";
import { downloadProfile } from "../settings/download-profile";
import {
  createDefaultProfile,
  parseProfileImport,
  PICKUP_CLASS_SYMBOLS,
  validateProfile,
  type BlissHackProfileExportV1,
  type BlissHackProfileV1,
  type InterfaceSettingsV1,
  type NetHackSettingsV1,
  type NumberPadMode,
  type PickupClassSymbol,
} from "../settings/profile";
import { diffProfiles, type ProfileDifference } from "../settings/profile-diff";
import type { ProfileLoadStatus } from "../settings/profile-store";
import { PRODUCT_VERSION } from "../version";
import type {
  BackupImportPreview,
} from "../backup/backup-operations";
import type {
  FullBackupExport,
  FullBackupImportResult,
} from "../session/session-manager";
import { DataManagementSection } from "./DataManagementSection";
import { GameLockCancelledError } from "../concurrency/game-lock";
import { ProfileStaleError } from "../settings/profile-store";

interface SettingsScreenProps {
  context?: "home" | "game";
  getDiagnosticCount?: () => number;
  loadStatus: ProfileLoadStatus;
  moduleId: string;
  onApply(
    profile: BlissHackProfileV1,
    baseProfile: BlissHackProfileV1,
  ): Promise<BlissHackProfileV1>;
  onBack(): void;
  onClearLocalData?: () => Promise<void>;
  onExportFullBackup?: () => Promise<FullBackupExport>;
  onExportProfile?: () => Promise<BlissHackProfileV1>;
  onImportFullBackup?: (
    preview: BackupImportPreview,
    overwriteFileNames: ReadonlySet<string>,
  ) => Promise<FullBackupImportResult>;
  onPersistenceResult?: (result: string) => void;
  onPreviewFullBackup?: (
    bytes: Uint8Array,
  ) => Promise<BackupImportPreview>;
  profile: BlissHackProfileV1;
  saveCount?: number;
  storageAvailable?: boolean;
}

interface ImportPreview {
  differences: ProfileDifference[];
  document: BlissHackProfileExportV1;
  profile: BlissHackProfileV1;
}

type Confirmation = "leave" | "restore" | null;
type SettingsErrorSource = "form" | "profile-export" | "profile-import";

interface SettingsError {
  message: string;
  source: SettingsErrorSource;
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

/**
 * Edit one complete profile without changing the prepared game module.
 * @param props - authoritative profile and application navigation callbacks.
 * @returns the Home Settings screen.
 */
export function SettingsScreen({
  context = "home",
  getDiagnosticCount = () => 0,
  loadStatus,
  moduleId,
  onApply,
  onBack,
  onClearLocalData = async () => {
    throw new Error("Local data clearing is unavailable");
  },
  onExportFullBackup = async () => {
    throw new Error("Full backup export is unavailable");
  },
  onExportProfile = async () => {
    throw new Error("Profile export is unavailable");
  },
  onImportFullBackup = async () => {
    throw new Error("Full backup import is unavailable");
  },
  onPersistenceResult,
  onPreviewFullBackup = async () => {
    throw new Error("Full backup preview is unavailable");
  },
  profile,
  saveCount = 0,
  storageAvailable: saveStorageAvailable = true,
}: SettingsScreenProps) {
  const [draft, setDraft] = useState(() => validateProfile(profile));
  const draftBaseProfile = useRef(validateProfile(profile));
  const previousProfile = useRef(validateProfile(profile));
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<SettingsError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [profilePending, setProfilePending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const storageAvailable = loadStatus !== "unavailable";
  const isGameSettings = context === "game";

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const previous = previousProfile.current;
    const next = validateProfile(profile);
    previousProfile.current = next;
    const previousValue = JSON.stringify(previous);
    const nextValue = JSON.stringify(next);
    const draftValue = JSON.stringify(draft);
    if (draftValue === nextValue) {
      draftBaseProfile.current = next;
    }
    if (previousValue === nextValue) return;
    if (draftValue === previousValue) {
      draftBaseProfile.current = next;
      setDraft(next);
    }
  }, [draft, profile]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    /** Return or dismiss the active confirmation without leaking Esc to the game. */
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (importPreview) {
        setImportPreview(null);
      } else if (confirmation) {
        setConfirmation(null);
      } else {
        requestBack();
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  });

  /** Save one complete candidate and retain the draft if persistence fails. */
  async function commit(
    candidate: BlissHackProfileV1,
    message: string,
    errorSource: SettingsErrorSource,
  ): Promise<boolean> {
    setError(null);
    setSuccess(null);
    setProfilePending(true);
    try {
      const saved = await onApply(candidate, draftBaseProfile.current);
      draftBaseProfile.current = saved;
      setDraft(saved);
      setSuccess(message);
      return true;
    } catch (error) {
      if (error instanceof GameLockCancelledError) return false;
      if (error instanceof ProfileStaleError && error.latestProfile) {
        draftBaseProfile.current = error.latestProfile;
      }
      setError({
        message: error instanceof ProfileStaleError
          ? "Settings changed in another page. Review your changes and try again."
          : "Settings could not be saved. Your previous settings are unchanged.",
        source: errorSource,
      });
      return false;
    } finally {
      setProfilePending(false);
    }
  }

  /** Submit the current draft through the single profile replacement boundary. */
  async function applyDraft(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> {
    event.preventDefault();
    if (!dirty || !storageAvailable || profilePending) return;
    if (await commit(draft, "Settings saved", "form")) onBack();
  }

  /** Leave immediately when clean, otherwise require explicit discard. */
  function requestBack(): void {
    if (dirty) {
      setConfirmation("leave");
    } else {
      onBack();
    }
  }

  /** Parse one selected .bhprofile and retain it only for confirmation. */
  async function readImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setError(null);
    setSuccess(null);
    if (!file.name.toLowerCase().endsWith(".bhprofile")) {
      setError({
        message: "Choose a .bhprofile file.",
        source: "profile-import",
      });
      return;
    }

    try {
      const document = parseProfileImport(
        new Uint8Array(await file.arrayBuffer()),
      );
      const incoming = validateProfile({
        schemaVersion: document.schemaVersion,
        interface: document.interface,
        nethack: document.nethack,
      });
      setImportPreview({
        differences: diffProfiles(profile, incoming),
        document,
        profile: incoming,
      });
    } catch {
      setError({
        message: "The selected profile is damaged, unsupported, or invalid.",
        source: "profile-import",
      });
    }
  }

  /** Import the retained candidate as one complete profile replacement. */
  async function confirmImport(): Promise<void> {
    if (!importPreview || !storageAvailable || profilePending) return;
    if (await commit(
      importPreview.profile,
      "Profile imported",
      "profile-import",
    )) {
      setImportPreview(null);
    }
  }

  /** Restore and persist reviewed defaults after confirmation. */
  async function confirmRestore(): Promise<void> {
    if (!storageAvailable || profilePending) return;
    if (await commit(createDefaultProfile(), "Defaults restored", "form")) {
      setConfirmation(null);
    }
  }

  /** Export the profile reloaded under the shared browser lock. */
  async function exportProfile(): Promise<void> {
    if (profilePending) return;
    setError(null);
    setProfilePending(true);
    try {
      downloadProfile(await onExportProfile(), PRODUCT_VERSION);
    } catch (error) {
      if (!(error instanceof GameLockCancelledError)) {
        setError({
          message: "The profile could not be exported.",
          source: "profile-export",
        });
      }
    } finally {
      setProfilePending(false);
    }
  }

  return (
    <main
      className={`settings-screen${isGameSettings ? " settings-screen-game" : ""}`}
      data-module-id={moduleId}
      aria-labelledby="settings-title"
    >
      <header className="settings-header">
        <button
          aria-label={isGameSettings ? "Back to Pause" : "Back to Home"}
          className="settings-back"
          onClick={(event) => {
            confirmationTriggerRef.current = event.currentTarget;
            requestBack();
          }}
          title={isGameSettings ? "Back to Pause" : "Back to Home"}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={19} />
        </button>
        <div>
          <span>BlissHack</span>
          <h1 id="settings-title">Settings</h1>
        </div>
        <span className="settings-version">{PRODUCT_VERSION}</span>
      </header>

      <form
        aria-describedby={error?.source === "form" ? "settings-error" : undefined}
        className="settings-form"
        onSubmit={applyDraft}
      >
        {profileStatusMessage(loadStatus) && (
          <p className="settings-warning" role="alert">
            {profileStatusMessage(loadStatus)}
          </p>
        )}
        {error && (
          <p className="settings-error" id="settings-error" role="alert">
            {error.message}
          </p>
        )}
        {success && <p className="settings-success" role="status">{success}</p>}

        <section className="settings-section" aria-labelledby="interface-title">
          <header>
            <h2 id="interface-title">Interface</h2>
          </header>
          <div className="settings-fields">
            <SegmentedField
              label="Terminal font size"
              name="terminal-font-size"
              onChange={(terminalFontSize) => {
                updateInterface(setDraft, { terminalFontSize });
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
                updateInterface(setDraft, {
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
                updateInterface(setDraft, { followPlayer });
              }}
            />
            <fieldset className="settings-field settings-subsection">
              <legend>Status display</legend>
              <div className="settings-toggle-grid">
                <ToggleField
                  checked={draft.nethack.showExperience}
                  label="Show experience"
                  onChange={(showExperience) => {
                    updateNetHack(setDraft, { showExperience });
                  }}
                />
                <ToggleField
                  checked={draft.nethack.showTime}
                  label="Show turn count"
                  onChange={(showTime) => {
                    updateNetHack(setDraft, { showTime });
                  }}
                />
              </div>
            </fieldset>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="inventory-title">
          <header>
            <h2 id="inventory-title">Inventory</h2>
          </header>
          <div className="settings-fields">
            <ToggleField
              checked={draft.nethack.autopickup}
              label="Automatic pickup"
              onChange={(autopickup) => updateNetHack(setDraft, { autopickup })}
            />
            <fieldset className="settings-field settings-pickup">
              <legend>Pickup categories</legend>
              <div className="settings-segments settings-segments-compact">
                {(["all", "selected"] as const).map((mode) => (
                  <label key={mode}>
                    <input
                      checked={draft.nethack.pickupTypes.mode === mode}
                      name="pickup-mode"
                      onChange={() => {
                        updateNetHack(setDraft, {
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
              {draft.nethack.pickupTypes.mode === "selected" && (
                <div className="settings-pickup-grid">
                  {PICKUP_CLASSES.map(({ symbol, label }) => {
                    const selected = draft.nethack.pickupTypes.mode === "selected"
                      ? draft.nethack.pickupTypes.classes
                      : [];
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
                            updateNetHack(setDraft, {
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
              onChange={(sortpack) => updateNetHack(setDraft, { sortpack })}
            />
            <fieldset className="settings-field settings-subsection">
              <legend>Permanent Inventory</legend>
              <ToggleField
                checked={draft.nethack.permInvent}
                label="Enable Permanent Inventory"
                onChange={(permInvent) => {
                  updateNetHack(setDraft, { permInvent });
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
                      updateNetHack(setDraft, {
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
                    updateInterface(setDraft, { permanentInventoryPosition });
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
                    updateInterface(setDraft, { permanentInventoryCollapsed });
                  }}
                />
              </div>
            </fieldset>
          </div>
        </section>

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
              onChange={(tutorial) => updateNetHack(setDraft, { tutorial })}
            />
            <label className="settings-field settings-select">
              <span>Movement keys</span>
              <select
                onChange={(event) => {
                  updateNetHack(setDraft, {
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
              onChange={(safePet) => updateNetHack(setDraft, { safePet })}
            />
          </div>
        </section>

        {!isGameSettings && (
          <section className="settings-section" aria-labelledby="profile-title">
            <header>
              <h2 id="profile-title">Profile</h2>
            </header>
            <div className="settings-profile-actions">
              <button
                aria-describedby={
                  error?.source === "profile-export"
                    ? "settings-error"
                    : undefined
                }
                disabled={profilePending}
                onClick={() => void exportProfile()}
                type="button"
              >
                <Download aria-hidden="true" size={17} />
                Export Profile
              </button>
              <button
                aria-describedby={
                  error?.source === "profile-import"
                    ? "settings-error"
                    : undefined
                }
                disabled={!storageAvailable || profilePending}
                onClick={() => fileInputRef.current?.click()}
                ref={importButtonRef}
                type="button"
              >
                <Upload aria-hidden="true" size={17} />
                Import Profile
              </button>
              <input
                accept=".bhprofile,application/json"
                aria-describedby={
                  error?.source === "profile-import"
                    ? "settings-error"
                    : undefined
                }
                aria-invalid={error?.source === "profile-import" || undefined}
                aria-label="Import profile file"
                className="settings-file-input"
                disabled={!storageAvailable}
                onChange={(event) => void readImport(event)}
                ref={fileInputRef}
                type="file"
              />
              <button
                disabled={!storageAvailable || profilePending}
                onClick={(event) => {
                  confirmationTriggerRef.current = event.currentTarget;
                  setConfirmation("restore");
                }}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={17} />
                Restore Defaults
              </button>
            </div>
          </section>
        )}

        {!isGameSettings && (
          <DataManagementSection
            dirty={dirty}
            getDiagnosticCount={getDiagnosticCount}
            onApplyProfile={(candidate) => {
              return onApply(candidate, draftBaseProfile.current)
                .then((saved) => {
                  draftBaseProfile.current = saved;
                  setDraft(saved);
                  return saved;
                })
                .catch((error: unknown) => {
                  if (error instanceof ProfileStaleError && error.latestProfile) {
                    draftBaseProfile.current = error.latestProfile;
                  }
                  throw error;
                });
            }}
            onClearLocalData={onClearLocalData}
            onExportFullBackup={onExportFullBackup}
            onImportFullBackup={onImportFullBackup}
            onPersistenceResult={onPersistenceResult}
            onPreviewFullBackup={onPreviewFullBackup}
            profile={profile}
            profilePresent={
              loadStatus !== "missing" && loadStatus !== "unavailable"
            }
            saveCount={saveCount}
            storageAvailable={
              saveStorageAvailable && loadStatus !== "unavailable"
            }
          />
        )}

        <footer className="settings-actions">
          <span>{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
          <button
            onClick={(event) => {
              confirmationTriggerRef.current = event.currentTarget;
              requestBack();
            }}
            type="button"
          >
            Cancel
          </button>
          <button
            className="settings-apply"
            disabled={!dirty || !storageAvailable || profilePending}
            type="submit"
          >
            Apply
          </button>
        </footer>
      </form>

      {confirmation === "leave" && (
        <ConfirmationDialog
          confirmLabel="Discard"
          message={`Discard unsaved settings and return to ${
            isGameSettings ? "Pause" : "Home"
          }?`}
          onCancel={() => setConfirmation(null)}
          onConfirm={onBack}
          returnFocusRef={confirmationTriggerRef}
          title="Unsaved settings"
        />
      )}
      {confirmation === "restore" && (
        <ConfirmationDialog
          confirmLabel="Restore"
          message="Replace all Interface and NetHack settings with defaults?"
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmRestore}
          returnFocusRef={confirmationTriggerRef}
          title="Restore defaults"
        />
      )}
      {importPreview && (
        <ImportPreviewDialog
          preview={importPreview}
          onCancel={() => setImportPreview(null)}
          onConfirm={confirmImport}
          returnFocusRef={importButtonRef}
        />
      )}
    </main>
  );
}

function SegmentedField<T extends string>({
  disabled = false,
  label,
  name,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  name: string;
  onChange(value: T): void;
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}) {
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

function ToggleField({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
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

function ConfirmationDialog({
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  returnFocusRef,
  title,
}: {
  confirmLabel: string;
  message: string;
  onCancel(): void;
  onConfirm(): void;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
}) {
  return (
    <SettingsModal
      alert
      label={title}
      onCancel={onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="settings-modal-actions">
        <button
          autoFocus
          data-modal-initial-focus
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button className="settings-danger" onClick={onConfirm} type="button">
          {confirmLabel}
        </button>
      </div>
    </SettingsModal>
  );
}

function ImportPreviewDialog({
  onCancel,
  onConfirm,
  preview,
  returnFocusRef,
}: {
  onCancel(): void;
  onConfirm(): void;
  preview: ImportPreview;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <SettingsModal
      className="settings-import-preview"
      label="Import profile"
      onCancel={onCancel}
      returnFocusRef={returnFocusRef}
    >
      <h2>Import profile</h2>
      <dl className="settings-import-meta">
        <div><dt>Version</dt><dd>{preview.document.productVersion}</dd></div>
        <div><dt>Exported</dt><dd>{formatExportTime(preview.document.exportedAt)}</dd></div>
      </dl>
      {preview.differences.length === 0
        ? <p>No settings differ.</p>
        : (
          <div className="settings-differences">
            <div className="settings-difference-heading">
              <span>Setting</span><span>Current</span><span>Incoming</span>
            </div>
            {preview.differences.map((difference) => (
              <div key={difference.path}>
                <strong>{difference.label}</strong>
                <span>{difference.current}</span>
                <span>{difference.incoming}</span>
              </div>
            ))}
          </div>
        )}
      <div className="settings-modal-actions">
        <button
          autoFocus
          data-modal-initial-focus
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="settings-primary"
          disabled={preview.differences.length === 0}
          onClick={onConfirm}
          type="button"
        >
          Import
        </button>
      </div>
    </SettingsModal>
  );
}

/**
 * Render a portal-backed Settings modal with focus containment and restoration.
 * @param props - modal semantics, content, and optional Escape cancellation.
 * @returns an accessible modal isolated from the Settings screen.
 */
function SettingsModal({
  alert = false,
  children,
  className = "",
  label,
  onCancel,
  returnFocusRef,
}: {
  alert?: boolean;
  children: ReactNode;
  className?: string;
  label: string;
  onCancel?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return undefined;
    const trigger = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const settingsScreen = document.querySelector<HTMLElement>(
      ".settings-screen",
    );
    if (settingsScreen) settingsScreen.inert = true;
    const initial = modal.querySelector<HTMLElement>(
      "[data-modal-initial-focus]",
    ) ?? modal.querySelector<HTMLElement>("button, input, select, textarea");
    initial?.focus();

    /** Keep keyboard focus and Escape handling inside the active modal. */
    function containFocus(event: KeyboardEvent): void {
      if (event.key === "Escape" && onCancelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modal!.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), "
          + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener("keydown", containFocus);
    return () => {
      modal.removeEventListener("keydown", containFocus);
      if (settingsScreen) settingsScreen.inert = false;
      globalThis.setTimeout(() => {
        if (
          trigger?.isConnected
          && !document.querySelector("[aria-modal='true']")
        ) {
          trigger.focus();
        }
      }, 0);
    };
  }, [returnFocusRef]);

  const modal = (
    <div className="settings-modal-backdrop">
      <section
        aria-label={label}
        aria-modal="true"
        className={`settings-modal${className ? ` ${className}` : ""}`}
        ref={ref}
        role={alert ? "alertdialog" : "dialog"}
      >
        {children}
      </section>
    </div>
  );
  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}

function updateInterface(
  setDraft: React.Dispatch<React.SetStateAction<BlissHackProfileV1>>,
  patch: Partial<InterfaceSettingsV1>,
): void {
  setDraft((current) => ({
    ...current,
    interface: { ...current.interface, ...patch },
  }));
}

function updateNetHack(
  setDraft: React.Dispatch<React.SetStateAction<BlissHackProfileV1>>,
  patch: Partial<NetHackSettingsV1>,
): void {
  setDraft((current) => ({
    ...current,
    nethack: { ...current.nethack, ...patch },
  }));
}

function profileStatusMessage(status: ProfileLoadStatus): string | null {
  if (status === "unavailable") {
    return "Browser settings storage is unavailable. Changes cannot be saved.";
  }
  if (status === "unsupported-schema") {
    return "Saved settings use an unsupported version. Defaults are shown.";
  }
  if (status === "invalid") {
    return "Saved settings could not be read. Defaults are shown.";
  }
  return null;
}

function formatExportTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
