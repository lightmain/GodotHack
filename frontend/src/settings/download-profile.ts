import { serializeProfileExport, type BlissHackProfileV1 } from "./profile";

/** Download one validated profile as a portable .bhprofile document. */
export function downloadProfile(
  profile: BlissHackProfileV1,
  productVersion: string,
): void {
  const blob = new Blob([serializeProfileExport(profile, productVersion)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "blisshack-profile.bhprofile";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}
