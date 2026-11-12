// Strongly consistent, optimistic-concurrency read/merge/write for release
// evidence. The adapter uses Netlify Blobs ETags: onlyIfNew / onlyIfMatch.
// A failed conditional write must re-read and re-apply the merge, never replay
// an already serialized stale JSON object.
export async function casMergeReleaseHistory(store,key,merge,{maxAttempts=12}={}){
  if(typeof key!=='string'||!key||typeof merge!=='function'
      ||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>30){
    throw new Error('RELEASE_HISTORY_CAS_ARGUMENT_INVALID');
  }
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const snapshot=await store.readJSON(key);
    const value=merge(snapshot?.data??null);
    const result=await store.writeJSON(key,value,snapshot?.etag||null);
    if(result?.modified===true)return value;
  }
  throw new Error('RELEASE_HISTORY_CONCURRENT_WRITE_EXHAUSTED');
}
