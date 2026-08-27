import { pruneExpiredAccountDeletionReceipts } from "./account";
import type { Env } from "./env";
import { pruneExpiredNativeGoogleAuthAttempts } from "./native-google-auth";
import { runRequestPortalMaintenance } from "./request-portal";

/** Removes expired security capabilities independently of user traffic. */
export async function runScheduledMaintenance(env: Env, scheduledTime: number): Promise<void> {
  await pruneExpiredNativeGoogleAuthAttempts(env.DB, scheduledTime);
  await pruneExpiredAccountDeletionReceipts(env.DB, scheduledTime);
  await runRequestPortalMaintenance(env, scheduledTime);
}
