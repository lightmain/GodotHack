import { createContext, useContext } from "react";
import type { BlissHackProfileV1 } from "./profile";
import type { ProfileLoadStatus } from "./profile-store";

export interface ProfileContextValue {
  profile: BlissHackProfileV1;
  loadStatus: ProfileLoadStatus;
  clearProfile(): BlissHackProfileV1;
  resetProfile(): BlissHackProfileV1;
  replaceProfile(profile: BlissHackProfileV1): BlissHackProfileV1;
}

export const ProfileContext = createContext<ProfileContextValue | null>(null);

/** Read the current profile and fail clearly outside its application owner. */
export function useProfileSettings(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfileSettings must be used inside ProfileProvider");
  }
  return value;
}
