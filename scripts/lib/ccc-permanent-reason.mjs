export function workItemHasCccPermanentReason(workItem, reasonCode) {
  const machineReason = `ccc-permanent:${reasonCode}`;
  return workItem?.blockedReason === machineReason
    && (
      workItem?.lastError === machineReason
      || workItem?.lastError?.startsWith(`${machineReason}: `) === true
    );
}
