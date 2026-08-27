import {
  createExpoAuthClient,
  createExpoSyncClient,
  createNativeGoogleAuth,
  type NativeGoogleCredentialProvider,
} from "@cloudflare-mobile-sync/expo-client";
import { Platform } from "react-native";
import {
  GoogleOneTapSignIn,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from "react-native-nitro-google-signin";

export const syncBaseUrl =
  process.env.EXPO_PUBLIC_MOBILE_SYNC_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:8787";

const configuredProviders = new Set(
  (process.env.EXPO_PUBLIC_MOBILE_SYNC_PROVIDERS ?? "")
    .split(",")
    .map((provider: string) => provider.trim().toLowerCase())
    .filter(Boolean),
);

export const nativeGoogleEnabled = Platform.OS === "android" && configuredProviders.has("google");
export const mobileScheme = "com.example.cloudflaremobilesync";

export const authClient = createExpoAuthClient({
  baseUrl: syncBaseUrl,
  scheme: mobileScheme,
  storagePrefix: "cloudflare-mobile-sync-example",
});

export const syncClient = createExpoSyncClient({
  baseUrl: syncBaseUrl,
  authClient,
});

let lastGoogleAccountId: string | null = null;

const googleCredentialProvider: NativeGoogleCredentialProvider = {
  async signIn({ webClientId, nonce }) {
    GoogleOneTapSignIn.configure({
      webClientId,
      nonce,
      offlineAccess: false,
      scopes: [],
    });
    await GoogleOneTapSignIn.checkPlayServices();
    let response = await GoogleOneTapSignIn.signIn();
    if (isNoSavedCredentialFoundResponse(response)) {
      response = await GoogleOneTapSignIn.createAccount();
    }
    if (isNoSavedCredentialFoundResponse(response)) {
      response = await GoogleOneTapSignIn.presentExplicitSignIn();
    }
    if (!isSuccessResponse(response)) {
      throw new Error("Google sign-in was cancelled");
    }
    lastGoogleAccountId = response.data.user.id;
    return { idToken: response.data.idToken };
  },
  async clearCredentialState() {
    await GoogleOneTapSignIn.signOut();
    lastGoogleAccountId = null;
  },
  async revokeAccess() {
    const accountId = GoogleOneTapSignIn.getCurrentUser()?.user.id ?? lastGoogleAccountId;
    if (!accountId) throw new Error("No active Google credential");
    await GoogleOneTapSignIn.revokeAccess(accountId);
    lastGoogleAccountId = null;
  },
};

export const nativeGoogleAuth = nativeGoogleEnabled
  ? createNativeGoogleAuth({
      applicationId: "com.example.cloudflaremobilesync",
      authClient,
      baseUrl: syncBaseUrl,
      credentialProvider: googleCredentialProvider,
      scheme: mobileScheme,
    })
  : null;
