import { koaMobileBarContract, koaVenueContract, type ContractTemplateContext } from './koa-contracts';

export type TenantContractTemplate = {
  title: string;
  sections: Array<{heading:string;body:string}>;
};

function genericVenueContract(tenantName:string,context:ContractTemplateContext):TenantContractTemplate {
  const client=context.clientName||'the Client';
  const eventDate=context.eventDate||'the date shown in the accepted proposal';
  const packageName=context.packageName||'venue services';
  const total=Number(context.total||0).toFixed(2);
  return {
    title:tenantName+' Venue & Services Agreement',
    sections:[
      {heading:'1. Event Details',body:'This agreement is between '+tenantName+' and '+client+' for the event scheduled for '+eventDate+'. The accepted proposal controls the selected services and event-specific details.'},
      {heading:'2. Services & Access',body:'The client agrees to follow the venue access, safety, vendor, staffing and operating requirements stated in the accepted proposal and event plan.'},
      {heading:'3. Payments',body:'The finalized proposal total is $'+total+' for the '+packageName+'. Payment amounts and due dates are those shown in the accepted proposal and payment schedule.'},
      {heading:'4. Changes & Cancellation',body:'Approved changes, cancellations and date changes are governed by the accepted proposal, organization policies and written amendments recorded for this booking.'},
      {heading:'5. Electronic Signature',body:'By signing electronically, the client confirms review of the agreement and accepted proposal and intends the recorded signature and timestamp to be binding.'},
    ],
  };
}

function genericMobileContract(tenantName:string,context:ContractTemplateContext):TenantContractTemplate {
  const base=genericVenueContract(tenantName,context);
  return {...base,title:tenantName+' Mobile Services Agreement'};
}

export function tenantContractTemplate(tenantId:string,tenantName:string,mobileBar:boolean,context:ContractTemplateContext):TenantContractTemplate {
  if(tenantId==='koa-events') return mobileBar?koaMobileBarContract(context):koaVenueContract(context);
  return mobileBar?genericMobileContract(tenantName,context):genericVenueContract(tenantName,context);
}
