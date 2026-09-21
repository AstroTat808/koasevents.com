export type VendorImportance='required'|'recommended'|'optional'|'not_needed';
export type VendorSuggestion={category:string;importance:VendorImportance;note:string;reasons:string[]};

const BASE:Array<[string,VendorImportance]>=[
  ['Wedding Planner','recommended'],['Photographer','recommended'],['Videographer','optional'],['Caterer','recommended'],
  ['Florist','optional'],['Officiant','recommended'],['DJ','optional'],['Live Musician','optional'],['Entertainment','optional'],
  ['Hair & Makeup','optional'],['Cake / Dessert','optional'],['Rentals','optional'],['Transportation','optional'],['Bartender / Mobile Bar','optional'],
];

function answerText(ops:any,category?:string){
  return (ops?.questionnaire||[])
    .filter((q:any)=>!category||String(q?.category||'')===category)
    .map((q:any)=>String(q?.answer||''))
    .join(' ')
    .toLowerCase();
}
function allText(record:any,ops:any){
  return [
    String(record?.packageId||''),
    String(record?.inquiry?.eventType||''),
    String(ops?.notes||''),
    answerText(ops),
  ].join(' ').toLowerCase();
}
function guests(record:any,ops:any){
  const n=Number(ops?.finalGuestCount||record?.quote?.state?.guestCount||record?.inquiry?.guestCount||0);
  return Number.isFinite(n)?n:0;
}
export function suggestVendorRequirements(record:any,ops:any):VendorSuggestion[]{
  const map=new Map<string,VendorSuggestion>(BASE.map(([category,importance])=>[category,{category,importance,note:'',reasons:['Koa’s baseline wedding planning recommendation.']}]));
  const set=(category:string,importance:VendorImportance,reason:string,note='')=>{
    const row=map.get(category);if(!row)return;
    row.importance=importance;
    row.reasons=[reason,...row.reasons.filter((r)=>r!==reason)].slice(0,4);
    if(note)row.note=note;
  };

  const guestCount=guests(record,ops);
  const text=allText(record,ops);
  const eventAnswers=answerText(ops,'event');
  const bar=answerText(ops,'bar');
  const decor=answerText(ops,'decor');
  const rentals=answerText(ops,'rentals');
  const timeline=answerText(ops,'timeline');
  const logistics=answerText(ops,'logistics');
  const packageId=String(record?.packageId||'').toLowerCase();

  if(guestCount>=60){
    set('Wedding Planner','required','Guest count is 60 or more, increasing coordination complexity.');
    set('Caterer','required','Guest count is 60 or more, so meal-service coordination should be locked in.');
    set('DJ','recommended','Larger guest count makes managed announcements and reception audio more useful.');
    set('Rentals','recommended','Larger guest count increases furniture, linen, tabletop, or layout needs.');
  }else if(guestCount>=30){
    set('Wedding Planner','recommended','Micro-wedding guest count still benefits from a single day-of coordination owner.');
    set('Caterer','recommended','Guest count suggests planned food service should be confirmed.');
  }else if(guestCount>0&&guestCount<=15){
    set('Wedding Planner','optional','Very small guest count can support a simplified coordination plan.');
    set('DJ','optional','Very small guest count may not require a dedicated DJ unless the timeline calls for one.');
  }

  const receptionOnly=/reception only|no ceremony|ceremony off[- ]?site|ceremony elsewhere|already married/.test(eventAnswers+' '+text);
  const ceremonyOnsite=!receptionOnly&&/ceremony|vows|officiant|processional/.test(eventAnswers+' '+timeline+' '+packageId);
  if(receptionOnly)set('Officiant','not_needed','Planning details indicate the ceremony is not being held at this event.');
  else if(ceremonyOnsite)set('Officiant','required','Planning details indicate an on-site ceremony.');

  const meal=/dinner|lunch|brunch|buffet|meal|food service|cater|reception/.test(eventAnswers+' '+text);
  if(meal)set('Caterer','required','Planning answers indicate a reception meal or food service.');

  const dry=/dry wedding|no alcohol|no bar|non[- ]?alcoholic only|alcohol[- ]?free/.test(bar+' '+text);
  const alcohol=!dry&&/open bar|hosted bar|beer|wine|cocktail|champagne|alcohol|mobile bar|bartender/.test(bar+' '+text);
  if(dry)set('Bartender / Mobile Bar','not_needed','Planning answers indicate no alcohol service.');
  else if(alcohol||/mobile[-_ ]?bar/.test(packageId))set('Bartender / Mobile Bar','required','Alcohol or bar service is part of the event plan.');

  if(/floral|flowers|bouquet|boutonniere|centerpiece|arch|lei/.test(decor))set('Florist','recommended','Decor answers include floral elements.');
  if(/cake|dessert|cupcake|pastry|sweet table/.test(decor))set('Cake / Dessert','recommended','Decor/menu answers include cake or dessert service.');
  if(/outside rental|rental company|chairs|tables|linen|tent|dance floor|place settings/.test(rentals+' '+text))set('Rentals','recommended','Planning answers identify rental inventory or outside rental coordination.');

  if(/first dance|parent dance|speeches|toast|grand entrance|announcement|dance floor|reception/.test(timeline))set('DJ','recommended','Timeline includes reception moments that benefit from managed audio and announcements.');
  if(/live music|musician|band|acoustic|ukulele|string quartet|guitar|piano/.test(timeline+' '+text))set('Live Musician','recommended','Planning details call for live music.');
  if(/photo booth|performer|entertainment|hula|fire dancer|magician/.test(timeline+' '+text))set('Entertainment','recommended','Planning details include specialty entertainment.');

  if(/shuttle|transport|bus|van|ride service|guest transportation/.test(logistics+' '+text))set('Transportation','recommended','Logistics answers indicate guest transportation coordination.');
  if(/hair|makeup|getting ready|bridal party/.test(text))set('Hair & Makeup','recommended','Planning details reference getting-ready or beauty services.');

  if(/elopement/.test(packageId+' '+text)){
    set('Officiant',receptionOnly?'not_needed':'required','Elopement format typically centers on the ceremony.');
    set('Photographer','recommended','Elopement format benefits from dedicated photography coverage.');
    if(guestCount>0&&guestCount<=15)set('Caterer','optional','Elopement-size guest count may use a simplified meal plan.');
  }
  if(/reception/.test(packageId)&&!/ceremony/.test(packageId))set('Officiant','not_needed','Package selection appears reception-focused.');
  if(/ceremony/.test(packageId))set('Officiant','required','Package selection includes ceremony service.');

  return [...map.values()];
}
export function baseVendorRequirements(){
  return BASE.map(([category,importance])=>({category,importance,note:''}));
}
