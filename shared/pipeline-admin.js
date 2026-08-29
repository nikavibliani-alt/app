/**
 * Sandbox client for pipeline AdminAction callable.
 * Deployed function id: pipeline-adminAction (codebase "pipeline", region europe-west1).
 *
 * Used by checkin-admin-sandbox.html only — live admin not wired yet.
 */

const PIPELINE_CALLABLE = 'pipeline-adminAction';

/**
 * @param {import('firebase/functions').Functions} functions — from getFunctions(app, 'europe-west1')
 * @param {typeof import('firebase/functions').httpsCallable} httpsCallable
 */
export function createPipelineAdminClient(functions, httpsCallable) {
  const fn = httpsCallable(functions, PIPELINE_CALLABLE);

  /**
   * @param {{password:string, actionType:string, payload:object, actor?:string}} req
   * @returns {Promise<{ok:boolean, errorCode:string, message:string, data?:object}>}
   */
  return async function callAdminAction(req) {
    const { data } = await fn({
      password: req.password,
      actionType: req.actionType,
      payload: req.payload || {},
      actor: req.actor || 'admin-sandbox',
    });
    return data;
  };
}

export { PIPELINE_CALLABLE };
