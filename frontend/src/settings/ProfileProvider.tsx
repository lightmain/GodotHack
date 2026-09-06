import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createDefaultProfile,
  type BlissHackProfileV1,
} from "./profile";
import {
  browserProfileStorage,
  createProfileStore,
  type ProfileStorage,
} from "./profile-store";
import {
  ProfileContext,
  type ProfileContextValue,
} from "./profile-context";

/**
 * Own the single live profile record shared by all application screens.
 * @param props - child tree and optional storage adapter for tests.
 * @returns context provider for profile consumers.
 */
export function ProfileProvider({
  children,
  storage,
}: {
  children?: ReactNode;
  storage?: ProfileStorage | null;
}) {
  const [store] = useState(() => createProfileStore(
    storage === undefined ? browserProfileStorage() : storage,
  ));
  const [state, setState] = useState(() => store.load());

  const replaceProfile = useCallback((profile: BlissHackProfileV1) => {
    const saved = store.replace(profile);
    setState({ profile: saved, status: "loaded" });
    return saved;
  }, [store]);

  const clearProfile = useCallback(() => {
    const cleared = store.clear();
    setState({ profile: cleared, status: "missing" });
    return cleared;
  }, [store]);

  const resetProfile = useCallback(() => {
    const profile = createDefaultProfile();
    setState({ profile, status: "missing" });
    return profile;
  }, []);

  const value = useMemo<ProfileContextValue>(() => ({
    profile: state.profile,
    loadStatus: state.status,
    clearProfile,
    resetProfile,
    replaceProfile,
  }), [clearProfile, replaceProfile, resetProfile, state]);

  return (
    <ProfileContext value={value}>
      {children}
    </ProfileContext>
  );
}
