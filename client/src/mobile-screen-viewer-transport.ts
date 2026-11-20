import { Capacitor } from "@capacitor/core";
import { isDesktop, isElectron } from "./desktop-bridge.js";
import { nativeInvoke } from "./native-network.js";
import { allocateNativeScreen } from "./transport.js";
import { createMobileScreenViewerTransport } from "./screen-mobile-transport.js";

export const isMobileScreenApp = () => !isDesktop() && ["ios", "android"].includes(Capacitor.getPlatform());
export const hasScreenViewer = () => isElectron() || isMobileScreenApp();
export const mobileScreenViewerTransport = createMobileScreenViewerTransport({ allocate: async () => {
  try { return await allocateNativeScreen(); }
  catch (error) { if ((error instanceof Error ? error.message : String(error)) === "invalid_native_kind") throw new Error("screen_mobile_update_required"); throw error; }
}, invoke: nativeInvoke });
