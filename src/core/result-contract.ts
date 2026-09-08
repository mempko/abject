/** Receiver-authored domain result semantics, negotiated through ordinary messages. */
export interface ResultContract { successField:string; errorField?:string; }
export function domainFailure(result:unknown,contract:ResultContract|null|undefined):string|undefined {
  if (!contract || !result || typeof result!=='object') return;
  const record=result as Record<string,unknown>;
  if (record[contract.successField]!==false) return;
  return String((contract.errorField && record[contract.errorField]) || 'Receiver rejected the operation');
}
