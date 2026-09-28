export type ContractTemplateContext = {
  clientName: string;
  eventDate: string;
  packageName: string;
  total: number;
};

export function koaVenueContract(context: ContractTemplateContext) {
  const client=context.clientName||'the Client';
  const eventDate=context.eventDate||'the date shown in the accepted proposal';
  const packageName=context.packageName||'Koa’s Events services';
  const total=Number(context.total||0).toFixed(2);
  return {
    title:'Koa’s Events Venue & Services Agreement',
    sections:[
      { heading: '1. Event Details', body: 'This Event Venue Rental Agreement is between Koa’s Events, 11-3330 Hibiscus St, Mountain View, HI 96771 (“Lessor” or “Koa’s”) and ' + client + ' (“Lessee”). The event is scheduled for ' + eventDate + '. The accepted proposal and finalized event plan supply the event type, rental period, package, quantities, and other event-specific details.' },
      { heading: '2. Premises Use & Access', body: 'Lessee is granted exclusive access to the property for the scheduled event. Koa’s Events reserves the right to define accessible areas if only a portion of the venue is being rented. Unauthorized access to non-designated areas is prohibited.' },
      { heading: '3. Payment Terms', body: 'The finalized proposal total is $' + total + ' for the ' + packageName + ' and finalized proposal scope. A 10% non-refundable deposit is required to reserve the event date. The first payment is due within 14 days of signing, the second payment is due 90 days before the event, and the final payment is due 60 days before the event. A $150 late fee applies per occurrence; two missed payments may result in event cancellation with no refund.' },
      { heading: '4. Security / Damage Deposit', body: 'The separate security or damage deposit required for the event is due 30 days before the event. Failure to pay authorizes cancellation by Koa’s. The deposit will be refunded within 14 days after the event, less deductions for damage, excessive cleanup, or breach.' },
      { heading: '5. Cancellation & Change of Date', body: 'Lessee may cancel within 15 calendar days of signing for a full refund. After that, all payments are non-refundable. Lessee may request one change to the event date by submitting a written request at least eight months before the originally scheduled date, subject to availability. A non-refundable change fee of $500 for single-day rentals or $1,000 for weekend rentals applies. Prior payments transfer to the approved new date; no additional date changes are permitted after the new date is confirmed.' },
      { heading: '6. Conduct, Safety, and Clean-Up', body: 'Lessee is responsible for guest behavior. Excess-mess cleanup, including vomit or spills, is charged at $50 per hour or per occurrence. All personal items and decor must be removed after the event. Children under 16 must be supervised by an adult. Smoking is allowed only in designated areas.' },
      { heading: '7. Vendors, Insurance, and Alcohol', body: 'Vendors must carry insurance naming Koa’s as additional insured, with proof due 30 days before the event. Event insurance is required, with the certificate due 60 days before the event. Only pre-approved bartenders are allowed. Self-serve bars and shots after 8:00 PM are prohibited; violation may result in event termination.' },
      { heading: '8. Intellectual Property & Media Use', body: 'Koa’s reserves all rights to its brand, decor, and imagery. Lessee may not use photos or likenesses of the venue for commercial purposes without written consent. By default, Koa’s may use photos from the event for promotional purposes unless the client opts out in writing.' },
      { heading: '9. Legal Terms & Electronic Signature', body: 'This Agreement is governed by Hawaii state law. Disputes are to be resolved through mediation, followed by binding arbitration in Hilo, Hawaii if necessary. Neither party is liable for events outside its control (Force Majeure). By signing electronically, Lessee confirms review of the accepted proposal and this Agreement, intends to sign electronically, and agrees that the recorded name, acknowledgement, and timestamp constitute Lessee’s signature.' },
    ],
  };
}

export function koaMobileBarContract(context: ContractTemplateContext) {
  const client=context.clientName||'the Client';
  const eventDate=context.eventDate||'the date shown in the accepted proposal';
  const packageName=context.packageName||'Koa’s Mobile Bar services';
  const total=Number(context.total||0).toFixed(2);
  return {
    title:'Koa’s Mobile Bar Services Agreement',
    sections:[
      { heading: '1. Event & Service Scope', body: 'This Mobile Bar Services Agreement is between Koa’s Events / Koa’s Mobile Bar (“Koa’s”) and ' + client + '. The event is scheduled for ' + eventDate + '. The accepted proposal controls the selected package, guest count, service hours, staffing, travel, add-ons, pricing, and other event-specific details.' },
      { heading: '2. Dry-Bar Alcohol Responsibility', body: 'Koa’s Mobile Bar operates as a dry-bar service. The Client is responsible for purchasing and supplying all alcoholic beverages. Koa’s may provide planning guidance and a shopping list based on the agreed menu and guest count, but the Client remains responsible for the alcohol purchase and availability.' },
      { heading: '3. Mobile Bar Access, Setup & Utilities', body: 'The Client is responsible for providing safe and reasonably level access for the mobile bar and adequate space for setup, service, and breakdown. Any venue restrictions, access limitations, utility requirements, parking instructions, or load-in rules must be disclosed before the event. Generator hookup or other service equipment will be used as described in the accepted proposal.' },
      { heading: '4. Staffing, Service Time & Guest Count', body: 'Bartender staffing, service duration, guest count, additional guests, additional service hours, gratuity structure, and any related charges are governed by the accepted proposal. Changes requested after proposal acceptance may require revised pricing and are subject to availability.' },
      { heading: '5. Travel & Location', body: 'Travel charges are based on the event location and the travel terms shown in the accepted proposal. The Client is responsible for providing an accurate event address and notifying Koa’s of location changes before the event.' },
      { heading: '6. Payments & Reservation', body: 'The finalized proposal total is $' + total + ' for the ' + packageName + ' and finalized scope. Payment amounts and due dates are those shown in the accepted proposal and booking payment schedule. The event date is not reserved until the required agreement and reservation payment are completed.' },
      { heading: '7. Add-ons, Custom Items & Final Adjustments', body: 'Custom-priced enhancements, personalized items, glassware, beverage stations, decor, menu presentation, and other selected add-ons are subject to the specifications, lead times, and pricing shown in the final proposal. Any approved changes will be reflected in the CRM proposal and payment records.' },
      { heading: '8. Safety, Service & Client Cooperation', body: 'Koa’s may pause or stop service when reasonably necessary for guest safety, staff safety, venue compliance, or responsible beverage service. The Client agrees to cooperate with Koa’s staff and venue requirements and to prevent unauthorized self-service from the mobile bar.' },
      { heading: '9. Electronic Signature & Entire Agreement', body: 'The accepted proposal, this agreement, and any written amendments recorded by Koa’s form the agreement for the mobile bar services. By signing electronically, the Client confirms review of the scope and pricing and agrees that the recorded name, acknowledgement, and timestamp constitute the Client’s electronic signature.' },
    ],
  };
}
