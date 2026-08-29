/**
 * Sandbox client for pipeline GuestRegister callable.
 * Deployed function id: pipeline-guestRegister (codebase "pipeline", region europe-west1).
 */

const PIPELINE_GUEST_CALLABLE = 'pipeline-guestRegister';

export function createPipelineGuestClient(functions, httpsCallable) {
  const fn = httpsCallable(functions, PIPELINE_GUEST_CALLABLE);
  return async function callGuestRegister(payload) {
    const { data } = await fn(payload);
    return data;
  };
}

export { PIPELINE_GUEST_CALLABLE };
