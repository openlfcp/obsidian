// The SDK's identity flows (@openlfcp/client 0.3.x, IDENTITY-PROFILE-01
// §§5–9) as one port, so that the device service is tested against the
// result kinds without a server. The plugin implements no protocol: every
// record, package and journal phase is the SDK's.

import {
  acceptInvitationAsDevice,
  addToRoster,
  approvePairing,
  cancelPairing,
  completePairing,
  connectionNetwork,
  createIdentityResource,
  createPairingSession,
  createResourceAsDevice,
  fetchDeks,
  loadIdentityDocument,
  openPairingSessions,
  outstandingDeliveries,
  pairingRequests,
  previewRevocation,
  reconcileDevices,
  registerDevice,
  requestPairing,
  resumeApproval,
  resumePairingSession,
  resumeRotations,
  revocationStatus,
  revokeDevice,
  rotateIfExposed,
  syncChain,
} from "@openlfcp/client";

export interface IdentityFlows {
  readonly acceptInvitationAsDevice: typeof acceptInvitationAsDevice;
  readonly addToRoster: typeof addToRoster;
  readonly createIdentityResource: typeof createIdentityResource;
  readonly createResourceAsDevice: typeof createResourceAsDevice;
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
  readonly reconcileDevices: typeof reconcileDevices;
  readonly rotateIfExposed: typeof rotateIfExposed;
  /** Committed key changes whose new key is still owed to a reader (sdk-ts 0.5.1). */
  readonly outstandingDeliveries: typeof outstandingDeliveries;
  /** Resumes those, and key changes whose KEY_EPOCH answer was lost (sdk-ts 0.5.1). */
  readonly resumeRotations: typeof resumeRotations;
  readonly requestPairing: typeof requestPairing;
  readonly completePairing: typeof completePairing;
  readonly revocationStatus: typeof revocationStatus;
  readonly syncChain: typeof syncChain;
  readonly fetchDeks: typeof fetchDeks;
  readonly loadIdentityDocument: typeof loadIdentityDocument;
  readonly connectionNetwork: typeof connectionNetwork;
}

export const SDK_IDENTITY_FLOWS: IdentityFlows = Object.freeze({
  acceptInvitationAsDevice,
  addToRoster,
  createIdentityResource,
  createResourceAsDevice,
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
  reconcileDevices,
  rotateIfExposed,
  outstandingDeliveries,
  resumeRotations,
  requestPairing,
  completePairing,
  revocationStatus,
  syncChain,
  fetchDeks,
  loadIdentityDocument,
  connectionNetwork,
});
