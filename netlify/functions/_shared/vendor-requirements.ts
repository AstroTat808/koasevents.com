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
function packageId(record:any){
  return String(record?.packageId||record?.quote?.state?.startingPoint||record?.inquiry?.venuePackage||'').trim().toLowerCase();
}
function quoteSelectionText(record:any){
  const selected=Array.isArray(record?.quote?.state?.selected)?record.quote.state.selected:[];
  return selected.map((row:any)=>[row?.id,row?.name].filter(Boolean).join(' ')).join(' ').toLowerCase();
}
function inquiryText(record:any){
  const inquiry=record?.inquiry||{};
  return [
    inquiry.eventType,inquiry.weddingType,inquiry.eventStyle,inquiry.service,inquiry.services,
    inquiry.mobileBarPackage,inquiry.barPackage,inquiry.barService,inquiry.useKoaMobileBar,
    inquiry.koaMobileBar,inquiry.mobileBar,
  ].flatMap((value:any)=>Array.isArray(value)?value:[value]).map((value:any)=>String(value||'')).join(' ').toLowerCase();
}
function allText(record:any,ops:any){
  return [packageId(record),inquiryText(record),quoteSelectionText(record),String(ops?.notes||''),answerText(ops)].join(' ').toLowerCase();
}
function guests(record:any,ops:any){
  const n=Number(ops?.finalGuestCount||record?.quote?.state?.guestCount||record?.inquiry?.guestCount||0);
  return Number.isFinite(n)?Math.max(0,Math.round(n)):0;
}
function usesKoaMobileBar(record:any,ops:any){
  if(packageId(record)==='signature-wedding')return true;
  const text=[inquiryText(record),quoteSelectionText(record),answerText(ops,'bar')].join(' ');
  if(/no koa.?s mobile bar|outside bartender|another bartender/.test(text))return false;
  return /koa.?s mobile bar|mobile[-_ ]?bar|mobile-(oahu|maui|big-island|custom)/.test(text);
}
function isWedding(record:any,ops:any){
  const pkg=packageId(record);
  return ['gardenia','orchid','hibiscus','signature-wedding'].includes(pkg)||/wedding|elopement|ceremony|bridal|vows/.test(allText(record,ops));
}
function includedFurnitureCount(pkg:string){
  if(pkg==='signature-wedding')return 50;
  if(['gardenia','orchid','hibiscus'].includes(pkg))return 10;
  return 0;
}

export function suggestVendorRequirements(record:any,ops:any):VendorSuggestion[]{
  const map=new Map<string,VendorSuggestion>(BASE.map(([category,importance])=>[category,{category,importance,note:'',reasons:['Koa’s baseline wedding planning recommendation.']}]));
  const set=(category:string,importance:VendorImportance,reason:string,note='')=>{
    const row=map.get(category);if(!row)return;
    row.importance=importance;
    row.reasons=[reason,...row.reasons.filter((r)=>r!==reason)].slice(0,5);
    if(note)row.note=note;
  };

  const guestCount=guests(record,ops);
  const text=allText(record,ops);
  const eventAnswers=answerText(ops,'event');
  const barAnswers=answerText(ops,'bar');
  const decor=answerText(ops,'decor');
  const rentals=answerText(ops,'rentals');
  const timeline=answerText(ops,'timeline');
  const logistics=answerText(ops,'logistics');
  const pkg=packageId(record);
  const wedding=isWedding(record,ops);
  const koaBar=usesKoaMobileBar(record,ops);
  const furniture=includedFurnitureCount(pkg);
  const signature=pkg==='signature-wedding';

  if(!wedding){
    set('Officiant','not_needed','This booking is not identified as a wedding ceremony.');
    set('Hair & Makeup','not_needed','This booking is not identified as a wedding.');
    set('Wedding Planner',guestCount>=60?'recommended':'optional','Non-wedding events only need dedicated planning help when complexity or guest count warrants it.');
  }else if(guestCount>=60){
    set('Wedding Planner','required','Guest count is 60 or more, increasing coordination complexity.');
    set('Caterer','required','Guest count is 60 or more, so meal-service coordination should be locked in.');
    set('DJ','recommended','Larger guest count makes managed announcements and reception audio more useful.');
  }else if(guestCount>=30){
    set('Wedding Planner','recommended','A 30–59 guest wedding benefits from a single coordination owner.');
    set('Caterer','recommended','Guest count suggests planned food service should be confirmed.');
  }else if(guestCount>0&&guestCount<=15){
    set('Wedding Planner','optional','Very small guest count supports a simplified coordination plan.');
    set('DJ','optional','Very small guest count may not require a dedicated DJ unless the timeline calls for one.');
  }

  // Package-aware defaults based on the current Koa’s wedding collections.
  if(pkg==='gardenia'){
    set('Wedding Planner','not_needed','Gardenia includes a vendor coordinator and planning assistance.','Koa’s package coverage');
    set('Florist','optional','Gardenia includes a simple bridal bouquet; additional floral design is optional.','Simple bridal bouquet included');
    set('Cake / Dessert','not_needed','Gardenia includes cake and a champagne toast.','Cake included by Koa’s');
    set('DJ','optional','Gardenia includes Sonos surround sound; a DJ is optional unless managed reception audio or announcements are desired.');
  }else if(pkg==='orchid'){
    set('Wedding Planner','not_needed','Orchid includes on-site vendor coordination.','Koa’s package coverage');
    set('Florist','optional','Orchid includes a simple bridal bouquet; additional floral design is optional.','Simple bridal bouquet included');
    set('DJ','optional','Orchid includes Sonos surround sound; a DJ remains optional unless the timeline calls for managed audio.');
  }else if(pkg==='hibiscus'){
    set('Wedding Planner','not_needed','Hibiscus includes a vendor coordinator and day-of coordination support.','Koa’s package coverage');
    set('Florist','optional','Hibiscus includes a simple bridal bouquet; additional floral design is optional.','Simple bridal bouquet included');
    set('DJ','optional','Hibiscus includes Sonos surround sound; a DJ remains optional unless the timeline calls for managed audio.');
  }else if(signature){
    set('Wedding Planner','not_needed','Signature includes day-of coordination and a vendor coordinator.','Coordination included by Koa’s');
    set('Florist','not_needed','Signature includes deluxe floral arrangements.','Florals included by Koa’s');
    set('Cake / Dessert','not_needed','Signature includes the wedding cake.','Wedding cake included by Koa’s');
    set('Bartender / Mobile Bar','not_needed','Signature includes Koa’s Mobile Bar service under the dry-bar model.','Koa’s Mobile Bar included');
    set('Entertainment','optional','Signature already includes a photo booth and lawn games; additional entertainment is optional.');
    set('DJ','optional','Signature includes audio equipment and Sonos; a DJ is optional unless managed music/MC service is desired.');
  }

  const receptionOnly=/reception only|no ceremony|ceremony off[- ]?site|ceremony elsewhere|already married/.test(eventAnswers+' '+text);
  const ceremonyOnsite=!receptionOnly&&(wedding||/ceremony|vows|officiant|processional/.test(eventAnswers+' '+timeline));
  if(receptionOnly)set('Officiant','not_needed','Planning details indicate the ceremony is not being held at this event.');
  else if(ceremonyOnsite)set('Officiant','required','Planning details indicate an on-site wedding ceremony.');

  const meal=/dinner|lunch|brunch|buffet|meal|food service|cater|reception/.test(eventAnswers+' '+text);
  if(meal)set('Caterer','required','Planning details indicate a reception meal or food service.');

  const dry=/dry wedding|no alcohol|no bar|non[- ]?alcoholic only|alcohol[- ]?free/.test(barAnswers+' '+text);
  const alcohol=!dry&&/open bar|hosted bar|beer|wine|cocktail|champagne|alcohol|bartender/.test(barAnswers+' '+text);
  if(dry)set('Bartender / Mobile Bar','not_needed','Planning answers indicate no alcohol service.');
  else if(koaBar)set('Bartender / Mobile Bar','not_needed','Koa’s Mobile Bar is already included or selected for this event.','Koa’s Mobile Bar already selected');
  else if(alcohol)set('Bartender / Mobile Bar','required','Alcohol service is planned, and Koa’s requires approved bartenders.');

  if(/floral|flowers|bouquet|boutonniere|centerpiece|arch|lei/.test(decor)&&!signature)set('Florist','recommended','Decor answers include floral elements beyond the package baseline.');
  if(/cake|dessert|cupcake|pastry|sweet table/.test(decor)&&!signature&&pkg!=='gardenia')set('Cake / Dessert','recommended','Planning answers include cake or dessert service.');

  if(furniture>0&&guestCount>furniture){
    set('Rentals','recommended','Guest count exceeds the furniture included with this package.','Plan additional furniture/rentals for '+Math.max(0,guestCount-furniture)+' guests beyond package inventory');
  }else if(furniture>0&&guestCount>0&&guestCount<=furniture){
    set('Rentals','not_needed','The selected Koa’s package includes furniture for this guest count.','Package furniture currently covers the planned guest count');
  }else if(/outside rental|rental company|chairs|tables|linen|tent|dance floor|place settings/.test(rentals+' '+text)){
    set('Rentals','recommended','Planning answers identify rental inventory or outside rental coordination.');
  }else if(guestCount>=40){
    set('Rentals','recommended','Larger guest count increases furniture, linen, tabletop, or layout needs.');
  }

  if(/first dance|parent dance|speeches|toast|grand entrance|announcement|dance floor/.test(timeline))set('DJ','recommended','Timeline includes reception moments that benefit from managed audio and announcements.');
  if(/live music|musician|band|acoustic|ukulele|string quartet|guitar|piano/.test(timeline+' '+text))set('Live Musician','recommended','Planning details call for live music.');
  if(/photo booth|performer|entertainment|hula|fire dancer|magician/.test(timeline+' '+text)&&!signature)set('Entertainment','recommended','Planning details include specialty entertainment.');
  if(/shuttle|transport|bus|van|ride service|guest transportation/.test(logistics+' '+text))set('Transportation','recommended','Logistics answers indicate guest transportation coordination.');
  else if(guestCount>=75)set('Transportation','recommended','Guest count above 75 makes transportation and parking planning more important.');
  if(/hair|makeup|getting ready|bridal party/.test(text))set('Hair & Makeup','recommended','Planning details reference getting-ready or beauty services.');

  if(/elopement|micro wedding|micro-wedding|intimate wedding/.test(text)){
    set('Photographer','recommended','Intimate wedding formats benefit from dedicated photography coverage.');
    if(!receptionOnly)set('Officiant','required','The intimate wedding format centers on the ceremony.');
    if(guestCount>0&&guestCount<=15&&!meal)set('Caterer','optional','Very small guest count can support a simplified food plan.');
  }

  return [...map.values()];
}

export function baseVendorRequirements(){
  return BASE.map(([category,importance])=>({category,importance,note:''}));
}


export function isBaselineVendorRequirements(input:unknown){
  if(!Array.isArray(input)||input.length!==BASE.length)return false;
  const rows=input as any[];
  return BASE.every(([category,importance])=>{
    const row=rows.find((entry:any)=>String(entry?.category||'')===category);
    return Boolean(row)&&String(row.importance||'')===importance&&!String(row.note||'').trim();
  });
}
