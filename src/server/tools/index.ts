import { createToolContext, type ToolDeps } from './context.js';
import {
  publishEvent,
  getUpdates,
  getContractState,
  getBriefing,
  whoami
} from './events.js';
import {
  claimScope,
  releaseScope,
  releaseScopeViaGit,
  forceRelease,
  pauseClaimsForBranch,
  resumeClaimsForBranch,
  fetchUnreadNotifications,
  listClaims
} from './claim-tools.js';
import {
  publishDecision,
  amendDecision,
  supersedeDecision,
  recordDecision
} from './decision-tools.js';
import {
  exportSpaceRulesSnapshot,
  sessionSync,
  updateSpaceRules
} from './space-rules-tools.js';
import { postMessage, readThread } from './discussion-tools.js';
import { updateCoordPref } from './coord-pref-tool.js';
import { queuePendingEdit, clearQueue } from './queue-tools.js';
import {
  shareFinding,
  getFinding,
  acknowledgeFinding
} from './finding-tools.js';
import { shareArtifact } from './artifact-tool.js';
import {
  requestEditPermission,
  respondPermissionRequest
} from './permission-tools.js';
import { agentFocusChanged } from './focus-tool.js';
import {
  openDispute,
  disputePostMove,
  endDispute,
  updateDisputeTerminations
} from './dispute-tools.js';
import { spaceLeave, spaceKick, spaceRotateCode } from './space-tools.js';

export type { ClaimScopeTestHooks, SessionSyncResponse } from './context.js';
export { DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS } from './context.js';

export function createTeamemTools(deps: ToolDeps) {
  const ctx = createToolContext(deps);

  return {
    publishEvent: (input: Parameters<typeof publishEvent>[1]) =>
      publishEvent(ctx, input),
    getUpdates: (input: Parameters<typeof getUpdates>[1]) =>
      getUpdates(ctx, input),
    claimScope: (
      input: Parameters<typeof claimScope>[1],
      hooks?: Parameters<typeof claimScope>[2]
    ) => claimScope(ctx, input, hooks),
    releaseScope: (input: Parameters<typeof releaseScope>[1]) =>
      releaseScope(ctx, input),
    releaseScopeViaGit: (input: Parameters<typeof releaseScopeViaGit>[1]) =>
      releaseScopeViaGit(ctx, input),
    publishDecision: (input: Parameters<typeof publishDecision>[1]) =>
      publishDecision(ctx, input),
    amendDecision: (input: Parameters<typeof amendDecision>[1]) =>
      amendDecision(ctx, input),
    supersedeDecision: (input: Parameters<typeof supersedeDecision>[1]) =>
      supersedeDecision(ctx, input),
    recordDecision: (input: Parameters<typeof recordDecision>[1]) =>
      recordDecision(ctx, input),
    getContractState: (input: Parameters<typeof getContractState>[1]) =>
      getContractState(ctx, input),
    getBriefing: (input: Parameters<typeof getBriefing>[1]) =>
      getBriefing(ctx, input),
    exportSpaceRulesSnapshot: (
      input: Parameters<typeof exportSpaceRulesSnapshot>[1]
    ) => exportSpaceRulesSnapshot(ctx, input),
    sessionSync: (input: Parameters<typeof sessionSync>[1]) =>
      sessionSync(ctx, input),
    updateSpaceRules: (input: Parameters<typeof updateSpaceRules>[1]) =>
      updateSpaceRules(ctx, input),
    whoami: (input: Parameters<typeof whoami>[1]) => whoami(ctx, input),
    postMessage: (input: Parameters<typeof postMessage>[1]) =>
      postMessage(ctx, input),
    readThread: (input: Parameters<typeof readThread>[1]) =>
      readThread(ctx, input),
    updateCoordPref: (input: Parameters<typeof updateCoordPref>[1]) =>
      updateCoordPref(ctx, input),
    shareFinding: (input: Parameters<typeof shareFinding>[1]) =>
      shareFinding(ctx, input),
    getFinding: (input: Parameters<typeof getFinding>[1]) =>
      getFinding(ctx, input),
    acknowledgeFinding: (input: Parameters<typeof acknowledgeFinding>[1]) =>
      acknowledgeFinding(ctx, input),
    shareArtifact: (input: Parameters<typeof shareArtifact>[1]) =>
      shareArtifact(ctx, input),
    queuePendingEdit: (input: Parameters<typeof queuePendingEdit>[1]) =>
      queuePendingEdit(ctx, input),
    clearQueue: (input: Parameters<typeof clearQueue>[1]) =>
      clearQueue(ctx, input),
    requestEditPermission: (
      input: Parameters<typeof requestEditPermission>[1]
    ) => requestEditPermission(ctx, input),
    respondPermissionRequest: (
      input: Parameters<typeof respondPermissionRequest>[1]
    ) => respondPermissionRequest(ctx, input),
    agentFocusChanged: (input: Parameters<typeof agentFocusChanged>[1]) =>
      agentFocusChanged(ctx, input),
    openDispute: (input: Parameters<typeof openDispute>[1]) =>
      openDispute(ctx, input),
    disputePostMove: (input: Parameters<typeof disputePostMove>[1]) =>
      disputePostMove(ctx, input),
    endDispute: (input: Parameters<typeof endDispute>[1]) =>
      endDispute(ctx, input),
    updateDisputeTerminations: (
      input: Parameters<typeof updateDisputeTerminations>[1]
    ) => updateDisputeTerminations(ctx, input),
    spaceLeave: (input: Parameters<typeof spaceLeave>[1]) =>
      spaceLeave(ctx, input),
    spaceKick: (input: Parameters<typeof spaceKick>[1]) =>
      spaceKick(ctx, input),
    spaceRotateCode: (input: Parameters<typeof spaceRotateCode>[1]) =>
      spaceRotateCode(ctx, input),
    forceRelease: (input: Parameters<typeof forceRelease>[1]) =>
      forceRelease(ctx, input),
    fetchUnreadNotifications: (
      input: Parameters<typeof fetchUnreadNotifications>[1]
    ) => fetchUnreadNotifications(ctx, input),
    pauseClaimsForBranch: (input: Parameters<typeof pauseClaimsForBranch>[1]) =>
      pauseClaimsForBranch(ctx, input),
    resumeClaimsForBranch: (
      input: Parameters<typeof resumeClaimsForBranch>[1]
    ) => resumeClaimsForBranch(ctx, input),
    listClaims: (input: Parameters<typeof listClaims>[1]) =>
      listClaims(ctx, input)
  };
}

export type TeamemTools = ReturnType<typeof createTeamemTools>;
