// Strongly consistent optimistic concurrency control for release evidence.
// Netlify may commit a write and lose the response: recover by reading the
// durable value, not by assuming that a thrown write failed.
function containsCommittedEvidence(actual,expected){
  if(Object.is(actual,expected))return true;
  if(expected===null||typeof expected!=='object')return false;
  if(actual===null||typeof actual!=='object')return false;
  if(Array.isArray(expected)){
    return Array.isArray(actual)&&actual.length===expected.length
      &&expected.every((value,index)=>containsCommittedEvidence(actual[index],value));
  }
  if(Array.isArray(actual))return false;
  return Object.keys(expected).every(key=>
    Object.hasOwn(actual,key)&&containsCommittedEvidence(actual[key],expected[key]));
}

export async function casMergeReleaseHistory(store,key,merge,{maxAttempts=12}={}){
  if(typeof key!=='string'||!key||typeof merge!=='function'
      ||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>30){
    throw new Error('RELEASE_HISTORY_CAS_ARGUMENT_INVALID');
  }
  let latestError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const snapshot=await store.readJSON(key);
    // Recompute from the latest ETag on EVERY retry. Validation errors,
    // including stale signed run IDs, must not be swallowed.
    const value=merge(snapshot?.data??null);
    let modified=false;
    try{
      modified=(await store.writeJSON(key,value,snapshot?.etag||null))?.modified===true;
    }catch(error){
      latestError=error;
      // A network failure can be post-commit. A strong, exact evidence
      // readback is the only permitted recovery; no synthetic success.
      let durable=null;
      try{durable=(await store.readJSON(key))?.data??null;}catch{}
      if(containsCommittedEvidence(durable,value))return durable;
      // If an earlier write was not committed, retry its intent against the
      // newest version. A conflict with another writer is handled by merge.
      continue;
    }
    if(modified)return value;
    // CAS conflict: the next iteration re-reads and merges its newer ETag.
  }
  const error=new Error('RELEASE_HISTORY_CONCURRENT_WRITE_EXHAUSTED');
  if(latestError)error.cause=latestError;
  throw error;
}
