// ABOUTME: The public surface must keep exporting what adapters consume.

import { describe, expect, it } from "vitest";
import {
  buildDevinChatRequest,
  ConnectFrameReader,
  DevinApiError,
  DevinProtocolError,
  DevinStreamError,
  devinCliMetadata,
  devinDiscoveryMetadata,
  encodeConnectFrame,
  fetchDevinModels,
  fetchDevinUsage,
  getCachedModels,
  loginDevinWithPkce,
  normalizeDevinSessionToken,
  readConnectTrailerError,
  refreshDevinToken,
  resolveDevinCredentials,
  resolveDevinModel,
  resolveDevinSession,
  saveDevinCredentials,
  streamDevin,
  updateDevinModelsCache,
} from "../src/index.js";

describe("devin-core exports", () => {
  it("publishes the stream, discovery, credentials, and error surface", () => {
    for (const value of [
      streamDevin,
      fetchDevinModels,
      fetchDevinUsage,
      resolveDevinCredentials,
      resolveDevinSession,
      saveDevinCredentials,
      loginDevinWithPkce,
      refreshDevinToken,
      getCachedModels,
      updateDevinModelsCache,
      resolveDevinModel,
      buildDevinChatRequest,
      ConnectFrameReader,
      encodeConnectFrame,
      readConnectTrailerError,
      DevinApiError,
      DevinStreamError,
      DevinProtocolError,
      normalizeDevinSessionToken,
      devinCliMetadata,
      devinDiscoveryMetadata,
    ]) {
      expect(value).toBeDefined();
    }
  });
});
