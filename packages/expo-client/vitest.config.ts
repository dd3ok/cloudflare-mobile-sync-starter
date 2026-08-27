import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function stub(name: string): string {
  return fileURLToPath(new URL(`./test-stubs/${name}.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "expo-constants": stub("expo-constants"),
      "expo-linking": stub("expo-linking"),
      "expo-network": stub("expo-network"),
      "expo-secure-store": stub("expo-secure-store"),
      "expo-web-browser": stub("expo-web-browser"),
      "react-native": stub("react-native"),
    },
  },
  ssr: {
    noExternal: ["@better-auth/expo"],
  },
});
