/**
 * Sandbox client for pipeline GuestRegister callable.
 * Deployed: guestRegister · Emulator: guestRegister
 */

import { pipelineCallableName } from './pipeline-emulator.js';

const PIPELINE_GUEST_EXPORT = 'guestRegister';

export function createPipelineGuestClient(functions, httpsCallable) {
  const fn = httpsCallable(functions, pipelineCallableName(PIPELINE_GUEST_EXPORT));
  return async function callGuestRegister(payload) {
    const { data } = await fn(payload);
    return data;
  };
}

export { PIPELINE_GUEST_EXPORT as PIPELINE_GUEST_CALLABLE };
