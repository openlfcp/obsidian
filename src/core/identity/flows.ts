// The SDK's identity flows (@openlfcp/client 0.3.0, IDENTITY-PROFILE-01
// §§5–9) as one port, so that the device service is tested against the
// result kinds without a server. The plugin implements no protocol: every
// record, package and journal phase is the SDK's.

import {
  approvePairing,
  cancelPairing,
  completePairing,
  connectionNetwork,
  createIdentityResource,
  createPairingSession,
  fetchDeks,
  loadIdentityDocument,
  openPairingSessions,
  pairingRequests,
  previewRevocation,
  registerDevice,
  requestPairing,
  resumeApproval,
  resumePairingSession,
  revocationStatus,
  revokeDevice,
  syncChain,
} from "@openlfcp/client";

export interface IdentityFlows {
  readonly createIdentityResource: typeof createIdentityResource;
  readonly createPairingSession: typeof createPairingSession;
  readonly resumePairingSession: typeof resumePairingSession;
  readonly openPairingSessions: typeof openPairingSessions;
  readonly pairingRequests: typeof pairingRequests;
  readonly approvePairing: typeof approvePairing;
  readonly resumeApproval: typeof resumeApproval;
  readonly cancelPairing: typeof cancelPairing;
  readonly previewRevocation: typeof previewRevocation;
  readonly revokeDevice: typeof revokeDevice;
  readonly registerDevice: typeof registerDevice;
  readonly requestPairing: typeof requestPairing;
  readonly completePairing: typeof completePairing;
  readonly revocationStatus: typeof revocationStatus;
  readonly syncChain: typeof syncChain;
  readonly fetchDeks: typeof fetchDeks;
  readonly loadIdentityDocument: typeof loadIdentityDocument;
  readonly connectionNetwork: typeof connectionNetwork;
}

export const SDK_IDENTITY_FLOWS: IdentityFlows = Object.freeze({
  createIdentityResource,
  createPairingSession,
  resumePairingSession,
  openPairingSessions,
  pairingRequests,
  approvePairing,
  resumeApproval,
  cancelPairing,
  previewRevocation,
  revokeDevice,
  registerDevice,
  requestPairing,
  completePairing,
  revocationStatus,
  syncChain,
  fetchDeks,
  loadIdentityDocument,
  connectionNetwork,
});
