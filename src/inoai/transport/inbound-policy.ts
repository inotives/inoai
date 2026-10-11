// Compatibility entry point. The admission policy is application behavior;
// transport callers retain this path until the dedicated cleanup phase.
export { classifyIncomingMessage } from "../conversation/inbound-policy.js";
export type { EligibleIncomingMessage } from "../conversation/inbound-policy.js";
