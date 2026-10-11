import fs from 'node:fs';

const read=(path)=>fs.readFileSync(path,'utf8');
const business=read('src/data/businessRules.ts');
const catalog=read('src/data/catalog.ts');
const page=read('src/pages/mobile-bar/index.astro');
const faq=read('src/pages/mobile-bar/faq/index.astro');
const truth=read('docs/business-rules-source-of-truth.md');
const proposed=read('docs/proposed-business-rules.md');
const inquiry=read('src/pages/inquire/index.astro');

const required=[
  [business,"price: 1500"],[business,"price: 2000"],[business,"price: 2500"],
  [business,"$65 per hour per bartender"],[business,"Oahu $10 per guest"],[business,"Maui $12 per guest"],[business,"Big Island $15 per guest"],
  [business,"10% per bartender with a tip jar"],[business,"25% per bartender with no tip jar"],
  [business,"$2.00 per mile"],[business,"$150 long-distance logistics fee"],
  [catalog,"Starting at $1,500"],[catalog,"Starting at $2,000"],[catalog,"Starting at $2,500"],[catalog,"$65 / hour / bartender"],
  [catalog,"$150 up to 50 guests · +$3 / guest thereafter"],[catalog,"Starting at $350"],[catalog,"$2 / guest · $100 minimum"],
  [catalog,"$3 / guest · $175 minimum"],[catalog,"$4 / guest · $200 minimum"],[catalog,"$5 / guest · $250 minimum"],
  [catalog,"$6 / guest · $300 minimum"],[catalog,"$3 / piece"],[catalog,"$4.50 / piece"],[catalog,"Starting at $125"],
  [page,"$65 / hr"],[page,"10% / 25%"],[faq,"Oahu starts at $1,500"],[truth,"| Oahu | $1,500 |"],
  [inquiry,"Oahu — $1,500"],[inquiry,"Maui — $2,000"],[inquiry,"Big Island — $2,500 premium full bar"],
];
for(const [source,token] of required){
  if(!source.includes(token))throw new Error('Mobile Bar pricing sync missing: '+token);
}

const scoped=[business,catalog,page,faq,truth,proposed,inquiry].join('\n');
const banned=[
  "Starting at $1,200","Starting at $1,800","| Oahu | $1,200","| Big Island | $1,800",
  "$8/additional guest","$8 per guest over the standard 100-guest framework",
  "$1.50/mile after the first 20 miles","Bartender labor is included within the standard package assumptions",
  "standard bartender labor is included","Gratuity is optional. It is not built into a mandatory percentage bartender fee",
  "No tip jar by default"
];
for(const token of banned){
  if(scoped.includes(token))throw new Error('Stale Mobile Bar rule still present: '+token);
}
console.log('Mobile Bar pricing synchronization: PASS');
