import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";
import { ArrowLeft } from "lucide-react";
import { downloadProfile } from "../settings/download-profile";
import {
  createDefaultProfile,
  parseProfileImport,
  validateProfile,
  type BlissHackProfileV1,
  type InterfaceSettingsV1,
  type NetHackSettingsV1,
} from "../settings/profile";
import { diffProfiles } from "../settings/profile-diff";
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
import {
  ConfirmationDialog,
  ImportPreviewDialog,
  type ImportPreview,
} from "./settings/SettingsDialogs";
import {
  InterfaceSettingsSection,
  InventorySettingsSection,
  NetHackSettingsSection,
  ProfileSettingsSection,
} from "./settings/SettingsSections";

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

type Confirmation = "leave" | "restore" | null;
type SettingsErrorSource = "form" | "profile-export" | "profile-import";

interface SettingsError {
  message: string;
  source: SettingsErrorSource;
}

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

        <InterfaceSettingsSection
          draft={draft}
          onInterfaceChange={(patch) => updateInterface(setDraft, patch)}
          onNetHackChange={(patch) => updateNetHack(setDraft, patch)}
        />
        <InventorySettingsSection
          draft={draft}
          onInterfaceChange={(patch) => updateInterface(setDraft, patch)}
          onNetHackChange={(patch) => updateNetHack(setDraft, patch)}
        />
        <NetHackSettingsSection
          draft={draft}
          isGameSettings={isGameSettings}
          onInterfaceChange={(patch) => updateInterface(setDraft, patch)}
          onNetHackChange={(patch) => updateNetHack(setDraft, patch)}
        />

        {!isGameSettings && (
          <ProfileSettingsSection
            exportError={error?.source === "profile-export"}
            fileInputRef={fileInputRef}
            importButtonRef={importButtonRef}
            importError={error?.source === "profile-import"}
            onExport={() => void exportProfile()}
            onImport={(event) => void readImport(event)}
            onRestore={(trigger) => {
              confirmationTriggerRef.current = trigger;
              setConfirmation("restore");
            }}
            pending={profilePending}
            storageAvailable={storageAvailable}
          />
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
