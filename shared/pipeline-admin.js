/**
 * Sandbox client for pipeline AdminAction callable.
 * Deployed: adminAction · Emulator: adminAction
 */

import { pipelineCallableName } from './pipeline-emulator.js';

const PIPELINE_EXPORT = 'adminAction';

/**
 * @param {import('firebase/functions').Functions} functions — from getFunctions(app, 'europe-west1')
 * @param {typeof import('firebase/functions').httpsCallable} httpsCallable
 */
export function createPipelineAdminClient(functions, httpsCallable) {
  const fn = httpsCallable(functions, pipelineCallableName(PIPELINE_EXPORT));

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

export { PIPELINE_EXPORT as PIPELINE_CALLABLE };
