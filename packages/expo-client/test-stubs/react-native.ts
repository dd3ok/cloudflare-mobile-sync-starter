export const AppState = {
  addEventListener(): { remove(): void } {
    return { remove() {} };
  },
};

export const Platform = { OS: "android" };
