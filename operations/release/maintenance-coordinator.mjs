import { maintenanceCall } from './maintenance-journal.mjs';
import { operationPolicy, operationPolicyDigest } from './operation-policy.mjs';
import { publicReleaseJSON } from './engine-readiness.mjs';

const need=v=>{if(!v)throw new Error('RELEASE_MAINTENANCE_AUTHORITY_REQUIRED');};
export class MaintenanceCoordinator {
  constructor({runner,verify,estimatedMilliseconds,publicJSON=publicReleaseJSON}) {
    need(Number.isSafeInteger(estimatedMilliseconds) && estimatedMilliseconds>0 && estimatedMilliseconds<=operationPolicy.forwardWorkMs);
    Object.assign(this,{runner,verify,estimatedMilliseconds,publicJSON});
  }
  async context(releaseId) {
    return maintenanceCall(this.runner.client,'engine_maintenance_verification_context',[releaseId,null]);
  }
  async observation(operation) {
    const result=await maintenanceCall(this.runner.client,'authorize_maintenance_observation',[
      ...this.runner.args(),operation.operation_id,this.runner.actor]);
    return result;
  }
  async beforePublish(plan) {
    const releaseId=plan.release_id;
    let c=await this.context(releaseId);
    if(!c.need_receipt) {
      await this.verify({action:'need',release_id:releaseId});
      c=await this.context(releaseId);
    }
    // The verifier's measured/installed recovery budget is authoritative. The
    // caller cannot lower it to squeeze another mutation into the freeze.
    if(!c.operation) {
      const needReceipt=c.need_evidence;
      need(c.need_receipt && needReceipt);
      await maintenanceCall(this.runner.client,'admit_engine_maintenance',[...this.runner.args(),releaseId,c.need_receipt,
        this.estimatedMilliseconds,needReceipt.actual_recovery_ms,needReceipt.recovery_margin_ms,this.runner.actor]);
      return {ready:false,state:'MAINTENANCE_ADMITTED'};
    }
    const operation=c.operation;
    if(['recovering','recovery_required'].includes(operation.phase)) return {ready:false,state:'MAINTENANCE_REQUIRES_OWNED_RECOVERY'};
    const observation=await this.observation(operation);
    if(!observation.authorized) return {ready:false,state:'MAINTENANCE_OBSERVATION_WAIT',next_retry_at:observation.next_check_at};
    const health=await this.publicJSON('https://engine.smarter.poker/health');
    need(health.maintenance?.policyVersion===2 && health.maintenance.policyDigest===operationPolicyDigest &&
      health.maintenance.activationReceipt===c.receipts.READINESS.data.maintenance_activation_receipt);
    if(health.maintenance.operation?.operationId!==operation.operation_id || health.maintenance.readyForRestart!==true)
      return {ready:false,state:'MAINTENANCE_WAITING_FOR_ACTUAL_DRAIN',next_retry_at:observation.next_check_at};
    const evidence=c.need_evidence;
    need(evidence);
    const step=await maintenanceCall(this.runner.client,'authorize_maintenance_step',[...this.runner.args(),operation.operation_id,
      `publish:${plan.id}`,this.estimatedMilliseconds,evidence.actual_recovery_ms,evidence.recovery_margin_ms,
      'engine_cutover',c.need_receipt,this.runner.actor]);
    need(step?.step?.owner_id===this.runner.owner.owner_id && step.step.epoch===this.runner.owner.epoch &&
      step.step.operation_id===operation.operation_id && step.step.step_key===`publish:${plan.id}` &&
      Date.parse(step.step.not_after_at)>Date.now() &&
      (step.authorized===true || step.reason==='previous_authorization_requires_readback'));
    return {ready:true,operation_id:operation.operation_id,step};
  }
  async afterPublish(releaseId) {
    let c=await this.context(releaseId);
    need(c.operation);
    if(!['release_authorized','releasing','resumed'].includes(c.operation.phase)) {
      const proof=await this.verify({action:'safe_resume',release_id:releaseId,operation_id:c.operation.operation_id});
      await maintenanceCall(this.runner.client,'authorize_maintenance_release',[...this.runner.args(),c.operation.operation_id,proof.receipt_id,this.runner.actor]);
      return {ready:false,state:'MAINTENANCE_SAFE_RESUME_AUTHORIZED'};
    }
    const observation=c.operation.phase==='resumed'?{authorized:true,next_check_at:null}:await this.observation(c.operation);
    if(!observation.authorized) return {ready:false,state:'MAINTENANCE_OBSERVATION_WAIT',next_retry_at:observation.next_check_at};
    const health=await this.publicJSON('https://engine.smarter.poker/health');
    const observed=health.maintenance;
    need(observed?.policyVersion===2 && observed.policyDigest===operationPolicyDigest &&
      observed.activationReceipt===c.receipts.READINESS.data.maintenance_activation_receipt);
    if(c.operation.phase!=='resumed' || observed.operation?.operationId!==c.operation.operation_id || observed.operation.phase!=='resumed')
      return {ready:false,state:'MAINTENANCE_WAITING_FOR_RESUMED_RUNTIME',next_retry_at:observation.next_check_at};
    return {ready:true,operation_id:c.operation.operation_id};
  }
}
