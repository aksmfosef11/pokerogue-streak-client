// SPDX-License-Identifier: AGPL-3.0-only
// Native clear recovery is version-specific. The generic sync copies the root
// add-on over it and must not run until that process is deliberately updated.
export function assertNativeSyncSafety(version, nativeLog) {
  if (nativeLog.includes('"clear-candidate"')) {
    throw new Error(
      `${version}: sync would overwrite native clear-candidate recovery. Review and update the sync process before continuing.`,
    );
  }
}
